'use strict';

const { Client, GatewayIntentBits, EmbedBuilder, MessageFlags } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_VOLUME = 0.5;
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';

// yt-dlp rewrites its cookie file; the docker mount is read-only, so use a copy.
let cookieArgs = [];
if (fs.existsSync('cookies.txt')) {
  try {
    fs.copyFileSync('cookies.txt', 'cookies-yt.txt');
    cookieArgs = ['--cookies', 'cookies-yt.txt'];
  } catch (err) {
    console.error('Failed to copy cookies file:', err);
  }
}

const COLORS = {
  green: 0x2ecc71,
  blue: 0x3498db,
  orange: 0xe67e22,
  purple: 0x9b59b6,
  red: 0xe74c3c,
  greyple: 0x99aab5,
};

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Per-guild state
// ---------------------------------------------------------------------------

const guildStates = new Map();

function getGuildState(guildId) {
  let state = guildStates.get(guildId);
  if (state) return state;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  state = {
    queue: [],
    current: null,
    player,
    connection: null,
    textChannel: null,
    nowPlaying: null,
    idleTimer: null,
    ffmpeg: null,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    killFfmpeg(state);
    void playNext(guildId);
  });
  player.on('error', (err) => {
    console.error(`[${guildId}] player error:`, err);
    killFfmpeg(state);
    void playNext(guildId);
  });

  guildStates.set(guildId, state);
  return state;
}

function killFfmpeg(state) {
  if (state.ffmpeg) {
    state.ffmpeg.kill('SIGKILL');
    state.ffmpeg = null;
  }
}

function cancelIdleTimer(state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function startIdleTimer(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;
  cancelIdleTimer(state);
  state.idleTimer = setTimeout(() => {
    console.log(`[${guildId}] disconnecting due to inactivity`);
    void cleanupGuild(guildId);
  }, IDLE_TIMEOUT_MS);
}

async function deleteNowPlaying(state) {
  if (!state.nowPlaying) return;
  try {
    await state.nowPlaying.delete();
  } catch {}
  state.nowPlaying = null;
}

async function cleanupGuild(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;
  cancelIdleTimer(state);
  state.queue.length = 0;
  state.current = null;
  killFfmpeg(state);
  try {
    state.player.stop(true);
  } catch {}
  try {
    state.connection?.destroy();
  } catch {}
  await deleteNowPlaying(state);
  guildStates.delete(guildId);
}

// ---------------------------------------------------------------------------
// YouTube extraction (yt-dlp)
// ---------------------------------------------------------------------------

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YT_DLP, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });
}

const FORMAT_ARGS = ['-f', 'bestaudio[protocol^=https]/bestaudio/best'];

async function searchYoutube(query) {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch:${query}`;
  const out = await ytdlp(['-J', '--no-playlist', ...FORMAT_ARGS, ...cookieArgs, target]);
  const data = JSON.parse(out);
  const info = data.entries?.[0] ?? data;
  if (!info || !(info.webpage_url || info.url)) return null;
  return {
    title: info.title || 'Unknown',
    url: info.webpage_url || info.original_url || info.url,
    duration: info.duration || 0,
  };
}

// ---------------------------------------------------------------------------
// yt-dlp (download) -> ffmpeg (encode) -> Ogg Opus
// ---------------------------------------------------------------------------

// yt-dlp downloads the stream itself (chunked, with the right headers/cookies);
// handing the raw googlevideo URL to ffmpeg gets 403 Forbidden.
function spawnPipeline(videoUrl, guildId) {
  const dl = spawn(
    YT_DLP,
    ['--no-playlist', '--quiet', '--no-warnings', ...FORMAT_ARGS, ...cookieArgs, '-o', '-', videoUrl],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  dl.stderr.on('data', (d) => console.error(`[${guildId}] yt-dlp: ${d.toString().trim()}`));

  const args = [
    '-i', 'pipe:0',
    '-vn',
    '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,volume=${DEFAULT_VOLUME}`,
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'opus',
    '-loglevel', 'warning',
    'pipe:1',
  ];

  const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'inherit'] });
  dl.stdout.pipe(ffmpeg.stdin);
  // Broken pipe when ffmpeg is killed (skip/leave) is expected.
  ffmpeg.stdin.on('error', () => {});
  dl.stdout.on('error', () => {});
  ffmpeg.on('close', () => dl.kill('SIGKILL'));
  return ffmpeg;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

async function playNext(guildId) {
  const state = guildStates.get(guildId);
  if (!state?.connection) return;

  const song = state.queue.shift();
  state.current = song ?? null;

  if (!song) {
    await deleteNowPlaying(state);
    startIdleTimer(guildId);
    return;
  }
  cancelIdleTimer(state);

  const ffmpeg = spawnPipeline(song.url, guildId);
  state.ffmpeg = ffmpeg;
  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.OggOpus,
    metadata: song,
  });
  state.player.play(resource);

  await deleteNowPlaying(state);
  if (state.textChannel) {
    const embed = new EmbedBuilder()
      .setTitle('🎵 Now Playing')
      .setDescription(`**${song.title}**`)
      .setColor(COLORS.green)
      .addFields(
        { name: 'Duration', value: formatDuration(song.duration), inline: true },
        { name: 'Requested by', value: song.requester, inline: true },
      );
    try {
      state.nowPlaying = await state.textChannel.send({ embeds: [embed] });
    } catch (err) {
      console.error(`[${guildId}] failed to send now playing message:`, err);
    }
  }
}

function ensureConnection(state, interaction, voiceChannel) {
  const guild = interaction.guild;

  if (state.connection && state.connection.joinConfig.channelId !== voiceChannel.id) {
    state.connection.destroy();
    state.connection = null;
  }

  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      daveEncryption: true,
    });

    connection.on('debug', (msg) => console.log(`[voice ${guild.id}] ${msg}`));
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      const s = guildStates.get(guild.id);
      if (s?.connection === connection) s.connection = null;
    });
    connection.subscribe(state.player);
    state.connection = connection;
  }

  return state.connection;
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const COMMANDS = [
  {
    name: 'play',
    description: 'Play a song from YouTube (URL or search query)',
    options: [
      {
        name: 'query',
        description: 'YouTube URL or search query',
        type: 3,
        required: true,
      },
    ],
  },
  { name: 'skip', description: 'Skip the currently playing song' },
  { name: 'queue', description: 'Show the current music queue' },
  { name: 'clear', description: 'Clear all songs from the queue' },
  {
    name: 'remove',
    description: 'Remove a song from the queue by its number',
    options: [
      {
        name: 'number',
        description: 'The queue number of the song to remove',
        type: 4,
        required: true,
      },
    ],
  },
  { name: 'leave', description: 'Make the bot leave the voice channel' },
  { name: 'help', description: 'Show information about the bot commands' },
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async (c) => {
  const guildId = process.env.GUILD_ID;
  try {
    if (guildId) {
      const guild = await c.guilds.fetch(guildId);
      await guild.commands.set(COMMANDS);
      console.log(`Synced slash commands to guild ${guildId}`);
    } else {
      await c.application.commands.set(COMMANDS);
      console.log('Synced slash commands globally (may take up to 1 hour)');
    }
  } catch (err) {
    console.error('Failed to sync commands:', err);
  }
  console.log(`Bot is ready! Logged in as ${c.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  const guildId = interaction.guild.id;
  const member = interaction.member;

  switch (interaction.commandName) {
    case 'play': {
      const voiceChannel = member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({
          content: 'You need to be in a voice channel!',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      const state = getGuildState(guildId);
      state.textChannel = interaction.channel;

      try {
        ensureConnection(state, interaction, voiceChannel);
        await entersState(state.connection, VoiceConnectionStatus.Ready, 60_000);
      } catch (err) {
        console.error(`[${guildId}] failed to connect to voice:`, err);
        return interaction.editReply('Failed to connect to voice channel. Please try again.');
      }

      let song;
      try {
        const info = await searchYoutube(query);
        if (!info) return interaction.editReply('Could not find or play that song.');
        song = { ...info, requester: member.displayName };
      } catch (err) {
        console.error(`[${guildId}] search failed:`, err.message);
        return interaction.editReply('Could not find or play that song.');
      }

      state.queue.push(song);
      cancelIdleTimer(state);

      const embed = new EmbedBuilder()
        .setTitle('✅ Added to Queue')
        .setDescription(`**${song.title}**`)
        .setColor(COLORS.blue)
        .addFields(
          { name: 'Duration', value: formatDuration(song.duration), inline: true },
          { name: 'Position', value: String(state.queue.length), inline: true },
          { name: 'Requested by', value: song.requester, inline: true },
        );
      await interaction.editReply({ embeds: [embed] });

      if (state.player.state.status === AudioPlayerStatus.Idle) {
        await playNext(guildId);
      }
      break;
    }

    case 'skip': {
      const state = guildStates.get(guildId);
      if (!state || state.player.state.status !== AudioPlayerStatus.Playing) {
        return interaction.reply({ content: 'Nothing is playing right now.', flags: MessageFlags.Ephemeral });
      }
      const skipped = state.current;
      state.player.stop();

      const embed = new EmbedBuilder()
        .setTitle('⏭️ Skipped')
        .setDescription(skipped ? `**${skipped.title}**` : 'Current song')
        .setColor(COLORS.orange)
        .addFields({ name: 'Skipped by', value: member.displayName, inline: true });
      return interaction.reply({ embeds: [embed] });
    }

    case 'queue': {
      const state = guildStates.get(guildId);
      if (!state?.current && !state?.queue.length) {
        return interaction.reply({ content: 'The queue is empty.', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder().setTitle('🎵 Music Queue').setColor(COLORS.purple);

      if (state.current) {
        embed.addFields({
          name: 'Now Playing',
          value: `**${state.current.title}** [${formatDuration(state.current.duration)}]\nRequested by: ${state.current.requester}`,
        });
      }

      if (state.queue.length > 0) {
        let text = state.queue
          .slice(0, 15)
          .map((s, i) => `\`${i + 1}.\` **${s.title}** [${formatDuration(s.duration)}] - ${s.requester}`)
          .join('\n');
        if (state.queue.length > 15) text += `\n\n... and ${state.queue.length - 15} more songs`;
        embed.addFields({ name: 'Up Next', value: text });
      }

      embed.setFooter({ text: `Total songs in queue: ${state.queue.length}` });
      return interaction.reply({ embeds: [embed] });
    }

    case 'clear': {
      const state = getGuildState(guildId);
      const count = state.queue.length;
      state.queue.length = 0;

      const embed = new EmbedBuilder()
        .setTitle('🗑️ Queue Cleared')
        .setDescription(`Removed **${count}** songs from the queue.`)
        .setColor(COLORS.red)
        .addFields({ name: 'Cleared by', value: member.displayName, inline: true });
      return interaction.reply({ embeds: [embed] });
    }

    case 'remove': {
      const state = guildStates.get(guildId);
      const number = interaction.options.getInteger('number', true);

      if (!state || number < 1 || number > state.queue.length) {
        return interaction.reply({
          content: `Invalid queue number. Please use a number between 1 and ${state?.queue.length ?? 0}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const removed = state.queue.splice(number - 1, 1)[0];
      const embed = new EmbedBuilder()
        .setTitle('🗑️ Removed from Queue')
        .setDescription(`**${removed.title}**`)
        .setColor(COLORS.red)
        .addFields({ name: 'Removed by', value: member.displayName, inline: true });
      return interaction.reply({ embeds: [embed] });
    }

    case 'leave': {
      const state = guildStates.get(guildId);
      if (!state?.connection) {
        return interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
      }

      await cleanupGuild(guildId);

      const embed = new EmbedBuilder()
        .setTitle('👋 Goodbye!')
        .setDescription('Left the voice channel and cleared the queue.')
        .setColor(COLORS.greyple);
      return interaction.reply({ embeds: [embed] });
    }

    case 'help': {
      const embed = new EmbedBuilder()
        .setTitle('🎵 Music Bot Commands')
        .setDescription('Here are all the available commands:')
        .setColor(COLORS.blue);

      const commandsInfo = [
        ['/play <query>', 'Play a song from YouTube. You can paste a URL or search by name.'],
        ['/skip', 'Skip the currently playing song.'],
        ['/queue', 'Show the current music queue with all songs and who requested them.'],
        ['/clear', 'Remove all songs from the queue.'],
        ['/remove <number>', 'Remove a specific song from the queue by its number.'],
        ['/leave', 'Make the bot leave the voice channel and clear the queue.'],
        ['/help', 'Show this help message.'],
      ];
      for (const [name, value] of commandsInfo) {
        embed.addFields({ name, value });
      }
      embed.setFooter({ text: 'Enjoy your music! 🎶' });
      return interaction.reply({ embeds: [embed] });
    }
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Error: DISCORD_TOKEN environment variable not set');
  process.exit(1);
}
client.login(token);
