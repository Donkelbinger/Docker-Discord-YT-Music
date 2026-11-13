import discord
from discord import app_commands
from discord.ext import commands
import yt_dlp
import asyncio
import logging
import shutil
from collections import deque
from dataclasses import dataclass
from typing import Optional
import os
import ctypes.util

# Load opus for voice support
if not discord.opus.is_loaded():
    opus_path = ctypes.util.find_library('opus')
    if opus_path:
        discord.opus.load_opus(opus_path)
        print(f"Loaded opus from: {opus_path}")
    else:
        print("WARNING: Could not find opus library")

FFMPEG_OPTIONS = {
    'options': '-vn -af "loudnorm=I=-16:TP=-1.5:LRA=11,volume=0.5"'
}

YDL_OPTIONS = {
    'format': 'bestaudio[protocol^=https]/bestaudio/best',
    'noplaylist': True,
    'quiet': False,
    'no_warnings': False,
    'extract_flat': False,
    'socket_timeout': 30,
    'retries': 3,
    'remote_components': ['ejs:github'],
}

if os.path.isfile('cookies.txt'):
    shutil.copyfile('cookies.txt', 'cookies-yt.txt')
    YDL_OPTIONS['cookiefile'] = 'cookies-yt.txt'


def ffmpeg_options(headers: dict) -> dict:
    """Build ffmpeg options, passing the headers yt-dlp wants for the stream URL."""
    before = '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5'
    if headers:
        header_lines = ''.join(f'{k}: {v}\r\n' for k, v in headers.items())
        before += f' -headers "{header_lines}"'
    return {'before_options': before, **FFMPEG_OPTIONS}


@dataclass
class Song:
    title: str
    url: str
    requester: str
    duration: Optional[int] = None

    @property
    def duration_str(self) -> str:
        if not self.duration:
            return "Unknown"
        total_secs = int(self.duration)
        mins, secs = divmod(total_secs, 60)
        hours, mins = divmod(mins, 60)
        if hours:
            return f"{hours}:{mins:02d}:{secs:02d}"
        return f"{mins}:{secs:02d}"


class MusicQueue:
    def __init__(self):
        self.queue: deque[Song] = deque()
        self.current: Optional[Song] = None

    def add(self, song: Song):
        self.queue.append(song)

    def next(self) -> Optional[Song]:
        if self.queue:
            self.current = self.queue.popleft()
            return self.current
        self.current = None
        return None

    def clear(self):
        self.queue.clear()

    def remove(self, index: int) -> Optional[Song]:
        if 0 <= index < len(self.queue):
            song = self.queue[index]
            del self.queue[index]
            return song
        return None

    def __len__(self):
        return len(self.queue)


IDLE_TIMEOUT = 300  # 5 minutes


class MusicBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.voice_states = True
        super().__init__(command_prefix="!", intents=intents)
        self.music_queues: dict[int, MusicQueue] = {}
        self.idle_timers: dict[int, asyncio.Task] = {}
        self.now_playing_messages: dict[int, discord.Message] = {}

    def get_queue(self, guild_id: int) -> MusicQueue:
        if guild_id not in self.music_queues:
            self.music_queues[guild_id] = MusicQueue()
        return self.music_queues[guild_id]

    async def setup_hook(self):
        guild_id = os.getenv("GUILD_ID")
        if guild_id:
            guild = discord.Object(id=int(guild_id))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            print(f"Synced slash commands to guild {guild_id}")
        else:
            await self.tree.sync()
            print("Synced slash commands globally (may take up to 1 hour)")


bot = MusicBot()


async def start_idle_timer(guild_id: int):
    """Start idle disconnect timer for a guild."""
    if guild_id in bot.idle_timers:
        bot.idle_timers[guild_id].cancel()
    
    async def disconnect_after_idle():
        await asyncio.sleep(IDLE_TIMEOUT)
        guild = bot.get_guild(guild_id)
        if guild and guild.voice_client:
            queue = bot.get_queue(guild_id)
            queue.clear()
            queue.current = None
            await guild.voice_client.disconnect()
            print(f"Disconnected from {guild.name} due to inactivity")
    
    bot.idle_timers[guild_id] = asyncio.create_task(disconnect_after_idle())


def cancel_idle_timer(guild_id: int):
    """Cancel idle disconnect timer for a guild."""
    if guild_id in bot.idle_timers:
        bot.idle_timers[guild_id].cancel()
        del bot.idle_timers[guild_id]


async def search_youtube(query: str) -> Optional[dict]:
    """Search YouTube for a video or extract info from URL."""
    ydl_opts = YDL_OPTIONS.copy()
    
    if not query.startswith(('http://', 'https://')):
        ydl_opts['default_search'] = 'ytsearch'
        query = f"ytsearch:{query}"

    try:
        loop = asyncio.get_running_loop()
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = await loop.run_in_executor(None, lambda: ydl.extract_info(query, download=False))
            if info and 'entries' in info:
                info = info['entries'][0] if info['entries'] else None
            return info
    except Exception as e:
        print(f"Error searching YouTube: {e}")
        return None


async def get_stream_info(video_url: str) -> Optional[tuple[str, dict]]:
    """Get fresh stream URL and required HTTP headers for a video (URLs expire)."""
    ydl_opts = YDL_OPTIONS.copy()
    try:
        loop = asyncio.get_running_loop()
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = await loop.run_in_executor(None, lambda: ydl.extract_info(video_url, download=False))
            if info and info.get('url'):
                print(f"Stream format: {info.get('format_id')} ({info.get('ext')}, {info.get('protocol')})")
                return info['url'], info.get('http_headers') or {}
    except Exception as e:
        print(f"Error getting stream URL: {e}")
    return None


async def play_next(interaction: discord.Interaction):
    """Play the next song in the queue."""
    guild = interaction.guild
    if not guild:
        return

    queue = bot.get_queue(guild.id)
    voice_client = guild.voice_client

    if not voice_client or not voice_client.is_connected():
        return

    song = queue.next()
    if not song:
        if guild.id in bot.now_playing_messages:
            try:
                await bot.now_playing_messages[guild.id].delete()
            except:
                pass
            del bot.now_playing_messages[guild.id]
        await start_idle_timer(guild.id)
        return
    
    cancel_idle_timer(guild.id)

    stream = await get_stream_info(song.url)
    if not stream:
        print(f"Failed to get stream URL for: {song.title}")
        await play_next(interaction)
        return
    stream_url, headers = stream

    try:
        source = discord.FFmpegPCMAudio(stream_url, **ffmpeg_options(headers))
        
        def after_playing(error):
            if error:
                print(f"Player error: {error}")
            asyncio.run_coroutine_threadsafe(play_next(interaction), bot.loop)

        voice_client.play(source, after=after_playing)
        
        if guild.id in bot.now_playing_messages:
            try:
                await bot.now_playing_messages[guild.id].delete()
            except:
                pass
        
        embed = discord.Embed(
            title="🎵 Now Playing",
            description=f"**{song.title}**",
            color=discord.Color.green()
        )
        embed.add_field(name="Duration", value=song.duration_str, inline=True)
        embed.add_field(name="Requested by", value=song.requester, inline=True)
        
        msg = await interaction.channel.send(embed=embed)
        bot.now_playing_messages[guild.id] = msg
    except Exception as e:
        print(f"Error playing song: {e}")
        await play_next(interaction)


@bot.tree.command(name="play", description="Play a song from YouTube (URL or search query)")
@app_commands.describe(query="YouTube URL or search query")
async def play(interaction: discord.Interaction, query: str):
    if not interaction.guild:
        await interaction.response.send_message("This command can only be used in a server.", ephemeral=True)
        return

    if not interaction.user.voice:
        await interaction.response.send_message("You need to be in a voice channel!", ephemeral=True)
        return

    await interaction.response.defer()

    voice_channel = interaction.user.voice.channel
    voice_client = interaction.guild.voice_client

    try:
        if not voice_client:
            voice_client = await voice_channel.connect(timeout=60.0, reconnect=True, self_deaf=True)
        elif voice_client.channel != voice_channel:
            await voice_client.move_to(voice_channel)
    except Exception as e:
        print(f"Failed to connect to voice: {e}")
        await interaction.followup.send("Failed to connect to voice channel. Please try again.", ephemeral=True)
        return

    info = await search_youtube(query)
    if not info or not info.get('webpage_url'):
        await interaction.followup.send("Could not find or play that song.", ephemeral=True)
        return

    song = Song(
        title=info.get('title', 'Unknown'),
        url=info.get('webpage_url', query),
        requester=interaction.user.display_name,
        duration=info.get('duration')
    )

    queue = bot.get_queue(interaction.guild.id)
    queue.add(song)
    cancel_idle_timer(interaction.guild.id)

    embed = discord.Embed(
        title="✅ Added to Queue",
        description=f"**{song.title}**",
        color=discord.Color.blue()
    )
    embed.add_field(name="Duration", value=song.duration_str, inline=True)
    embed.add_field(name="Position", value=str(len(queue)), inline=True)
    embed.add_field(name="Requested by", value=song.requester, inline=True)

    await interaction.followup.send(embed=embed)

    if not voice_client.is_playing() and not voice_client.is_paused():
        await play_next(interaction)


@bot.tree.command(name="skip", description="Skip the currently playing song")
async def skip(interaction: discord.Interaction):
    if not interaction.guild:
        await interaction.response.send_message("This command can only be used in a server.", ephemeral=True)
        return

    voice_client = interaction.guild.voice_client
    if not voice_client or not voice_client.is_playing():
        await interaction.response.send_message("Nothing is playing right now.", ephemeral=True)
        return

    queue = bot.get_queue(interaction.guild.id)
    skipped_song = queue.current

    voice_client.stop()

    embed = discord.Embed(
        title="⏭️ Skipped",
        description=f"**{skipped_song.title}**" if skipped_song else "Current song",
        color=discord.Color.orange()
    )
    embed.add_field(name="Skipped by", value=interaction.user.display_name, inline=True)
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="queue", description="Show the current music queue")
async def show_queue(interaction: discord.Interaction):
    if not interaction.guild:
        await interaction.response.send_message("This command can only be used in a server.", ephemeral=True)
        return

    queue = bot.get_queue(interaction.guild.id)

    if not queue.current and len(queue) == 0:
        await interaction.response.send_message("The queue is empty.", ephemeral=True)
        return

    embed = discord.Embed(title="🎵 Music Queue", color=discord.Color.purple())

    if queue.current:
        embed.add_field(
            name="Now Playing",
            value=f"**{queue.current.title}** [{queue.current.duration_str}]\nRequested by: {queue.current.requester}",
            inline=False
        )

    if len(queue) > 0:
        queue_list = []
        for i, song in enumerate(queue.queue, 1):
            queue_list.append(f"`{i}.` **{song.title}** [{song.duration_str}] - {song.requester}")
        
        queue_text = "\n".join(queue_list[:15])
        if len(queue) > 15:
            queue_text += f"\n\n... and {len(queue) - 15} more songs"
        
        embed.add_field(name="Up Next", value=queue_text, inline=False)

    embed.set_footer(text=f"Total songs in queue: {len(queue)}")
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="clear", description="Clear all songs from the queue")
async def clear(interaction: discord.Interaction):
    if not interaction.guild:
        await interaction.response.send_message("This command can only be used in a server.", ephemeral=True)
        return

    queue = bot.get_queue(interaction.guild.id)
    count = len(queue)
    queue.clear()

    embed = discord.Embed(
        title="🗑️ Queue Cleared",
        description=f"Removed **{count}** songs from the queue.",
        color=discord.Color.red()
    )
    embed.add_field(name="Cleared by", value=interaction.user.display_name, inline=True)
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="remove", description="Remove a song from the queue by its number")
@app_commands.describe(number="The queue number of the song to remove")
async def remove(interaction: discord.Interaction, number: int):
    if not interaction.guild:
        await interaction.response.send_message("This command can only be used in a server.", ephemeral=True)
        return

    queue = bot.get_queue(interaction.guild.id)
    
    if number < 1 or number > len(queue):
        await interaction.response.send_message(
            f"Invalid queue number. Please use a number between 1 and {len(queue)}.",
            ephemeral=True
        )
        return

    removed_song = queue.remove(number - 1)
    
    if removed_song:
        embed = discord.Embed(
            title="🗑️ Removed from Queue",
            description=f"**{removed_song.title}**",
            color=discord.Color.red()
        )
        embed.add_field(name="Removed by", value=interaction.user.display_name, inline=True)
        await interaction.response.send_message(embed=embed)
    else:
        await interaction.response.send_message("Could not remove that song.", ephemeral=True)


@bot.tree.command(name="leave", description="Make the bot leave the voice channel")
async def leave(interaction: discord.Interaction):
    if not interaction.guild:
        await interaction.response.send_message("This command can only be used in a server.", ephemeral=True)
        return

    voice_client = interaction.guild.voice_client
    if not voice_client:
        await interaction.response.send_message("I'm not in a voice channel.", ephemeral=True)
        return

    queue = bot.get_queue(interaction.guild.id)
    queue.clear()
    queue.current = None
    cancel_idle_timer(interaction.guild.id)

    await voice_client.disconnect()

    embed = discord.Embed(
        title="👋 Goodbye!",
        description="Left the voice channel and cleared the queue.",
        color=discord.Color.greyple()
    )
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="help", description="Show information about the bot commands")
async def help_command(interaction: discord.Interaction):
    embed = discord.Embed(
        title="🎵 Music Bot Commands",
        description="Here are all the available commands:",
        color=discord.Color.blue()
    )
    
    commands_info = [
        ("/play <query>", "Play a song from YouTube. You can paste a URL or search by name."),
        ("/skip", "Skip the currently playing song."),
        ("/queue", "Show the current music queue with all songs and who requested them."),
        ("/clear", "Remove all songs from the queue."),
        ("/remove <number>", "Remove a specific song from the queue by its number."),
        ("/leave", "Make the bot leave the voice channel and clear the queue."),
        ("/help", "Show this help message."),
    ]
    
    for cmd, desc in commands_info:
        embed.add_field(name=cmd, value=desc, inline=False)

    embed.set_footer(text="Enjoy your music! 🎶")
    await interaction.response.send_message(embed=embed)


@bot.event
async def on_ready():
    print(f"Bot is ready! Logged in as {bot.user}")


if __name__ == "__main__":
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        print("Error: DISCORD_TOKEN environment variable not set")
        exit(1)
    bot.run(token, log_level=logging.DEBUG)
