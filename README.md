# Discord YouTube Music Bot

A Discord bot that streams YouTube music using yt-dlp, running in Docker.

## Features

- Stream YouTube audio in voice channels
- Search YouTube or play directly from URL
- Queue management with song information
- Shows who requested each song (without @mentions)

## Commands

| Command | Description |
|---------|-------------|
| `/play <query>` | Play a song (YouTube URL or search query) |
| `/skip` | Skip the current song |
| `/queue` | Show the queue with requesters |
| `/clear` | Clear all songs from queue |
| `/remove <number>` | Remove a song by queue number |
| `/leave` | Leave voice channel and clear queue |
| `/help` | Show command information |

## Setup

### 1. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token
5. Enable these Privileged Gateway Intents:
   - Message Content Intent
6. Go to OAuth2 > URL Generator:
   - Select scopes: `bot`, `applications.commands`
   - Select permissions: `Connect`, `Speak`, `Send Messages`, `Embed Links`
7. Use generated URL to invite bot to your server

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your Discord bot token:
```
DISCORD_TOKEN=your_actual_token_here
```

### 3. Add YouTube Cookies

Place your `cookies.txt` file in the project root. This is required for age-restricted videos and to avoid rate limiting.

You can export cookies using browser extensions like "Get cookies.txt LOCALLY".

### 4. Run with Docker

```bash
docker-compose up -d --build
```

### View Logs

```bash
docker-compose logs -f
```

### Stop Bot

```bash
docker-compose down
```

## File Structure

```
├── bot.py              # Main bot code
├── Dockerfile          # Docker image definition
├── docker-compose.yml  # Docker Compose configuration
├── requirements.txt    # Python dependencies
├── cookies.txt         # YouTube cookies (you provide this)
├── .env                # Environment variables (you create this)
└── .env.example        # Example environment file
```

## Troubleshooting

- **Bot not responding to commands**: Wait a few minutes after first start for slash commands to sync globally
- **Audio not playing**: Ensure cookies.txt is valid and ffmpeg is installed (handled by Docker)
- **Rate limited**: Your cookies may have expired, export fresh ones
