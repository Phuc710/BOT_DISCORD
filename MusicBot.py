import os
import discord
from discord.ext import commands, tasks
from discord import app_commands
import aiohttp
import asyncio
import yt_dlp
from collections import defaultdict, deque
import logging
from typing import Dict, Optional, List
import json
from dataclasses import dataclass, asdict
import time
from concurrent.futures import ThreadPoolExecutor
import weakref
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Enhanced logging setup - Fixed Unicode encoding issue
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('bot.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Environment variables
DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Validate required environment variables
required_env_vars = {
    "DISCORD_TOKEN": DISCORD_TOKEN,
    "OPENWEATHER_API_KEY": OPENWEATHER_API_KEY,
    "GEMINI_API_KEY": GEMINI_API_KEY
}

missing_vars = [var for var, value in required_env_vars.items() if not value]
if missing_vars:
    logger.error(f"Missing required environment variables: {', '.join(missing_vars)}")
    logger.error("Please check your .env file and ensure all required variables are set.")
    exit(1)

logger.info("All environment variables loaded successfully from .env file")

# Vietnam cities for weather (comprehensive list)
VIETNAM_CITIES = [
    "Ho Chi Minh City", "Hanoi", "Da Nang", "Can Tho", "Hai Phong",
    "Go Vap", "Cu Chi", "Bien Hoa", "Vung Tau", "Nha Trang",
    "Hue", "Quy Nhon", "Da Lat", "Phan Thiet", "Rach Gia",
    "Ca Mau", "Buon Ma Thuot", "Pleiku", "Kontum", "An Giang",
    "Long Xuyen", "My Tho", "Tra Vinh", "Soc Trang", "Bac Lieu",
    "Cao Lanh", "Sa Dec", "Vinh Long", "Ben Tre", "Dong Thap"
]

@dataclass
class Song:
    title: str
    url: str
    webpage_url: str
    duration: str
    uploader: str
    thumbnail: str
    requester: str
    
    def to_dict(self):
        return asdict(self)

@dataclass
class WeatherData:
    city: str
    temperature: float
    feels_like: float
    humidity: int
    description: str
    wind_speed: float
    icon: str

class OptimizedQueue:
    """Thread-safe optimized queue implementation"""
    def __init__(self):
        self._queue = deque()
        self._lock = asyncio.Lock()
    
    async def append(self, item):
        async with self._lock:
            self._queue.append(item)
    
    async def popleft(self):
        async with self._lock:
            if self._queue:
                return self._queue.popleft()
            return None
    
    async def clear(self):
        async with self._lock:
            self._queue.clear()
    
    async def list_items(self, limit=10):
        async with self._lock:
            return list(self._queue)[:limit]
    
    async def remove_item(self, index):
        async with self._lock:
            if 0 <= index < len(self._queue):
                del self._queue[index]
                return True
            return False
    
    def __len__(self):
        return len(self._queue)

class MusicPlayer:
    """Enhanced music player with caching and optimization"""
    
    def __init__(self, bot):
        self.bot = bot
        self.guilds_data = defaultdict(lambda: {
            'queue': OptimizedQueue(),
            'current_song': None,
            'text_channel': None,
            'volume': 0.5,
            'loop': False,
            'shuffle': False,
            'auto_disconnect_task': None
        })
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.ydl_cache = {}
        
        # Enhanced yt-dlp options
        self.ydl_options = {
            'format': 'bestaudio[ext=webm][abr<=128]/bestaudio[ext=m4a][abr<=128]/bestaudio',
            'noplaylist': True,
            'nocheckcertificate': True,
            'ignoreerrors': False,
            'logtostderr': False,
            'quiet': True,
            'no_warnings': True,
            'default_search': 'ytsearch',
            'source_address': '0.0.0.0',
            'force_json': True,
            'extract_flat': False,
            'cachedir': './cache',
            'max_downloads': 1,
            'socket_timeout': 30,
        }
        
        self.ffmpeg_options = {
            'before_options': '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5',
            'options': '-vn -filter:a "volume=0.5" -bufsize 512k'
        }
    
    async def search_song(self, query: str, requester: str) -> Optional[Song]:
        """Optimized song search with caching"""
        cache_key = f"search_{hash(query)}"
        
        if cache_key in self.ydl_cache:
            cached_result = self.ydl_cache[cache_key]
            cached_result['requester'] = requester
            return Song(**cached_result)
        
        try:
            if not query.startswith(('http://', 'https://')):
                query = f"ytsearch1:{query}"
            
            loop = asyncio.get_event_loop()
            
            def extract():
                with yt_dlp.YoutubeDL(self.ydl_options) as ydl:
                    info = ydl.extract_info(query, download=False)
                    if 'entries' in info and info['entries']:
                        return info['entries'][0]
                    return info
            
            info = await loop.run_in_executor(self.executor, extract)
            
            if not info:
                return None
            
            song_data = {
                'title': info.get('title', 'Unknown Title')[:100],
                'url': info.get('url'),
                'webpage_url': info.get('webpage_url', ''),
                'duration': self.format_duration(info.get('duration')),
                'uploader': info.get('uploader', 'Unknown')[:50],
                'thumbnail': info.get('thumbnail', ''),
                'requester': requester
            }
            
            # Cache the result
            self.ydl_cache[cache_key] = {k: v for k, v in song_data.items() if k != 'requester'}
            
            return Song(**song_data)
            
        except Exception as e:
            logger.error(f"Search error: {e}")
            return None
    
    def format_duration(self, duration):
        if not duration:
            return "Unknown"
        
        duration = int(duration)
        if duration > 3600:
            h, remainder = divmod(duration, 3600)
            m, s = divmod(remainder, 60)
            return f"{h}:{m:02d}:{s:02d}"
        else:
            m, s = divmod(duration, 60)
            return f"{m}:{s:02d}"
    
    async def play_next(self, guild):
        """Enhanced play_next with loop support"""
        guild_data = self.guilds_data[guild.id]
        voice_client = guild.voice_client
        
        if not voice_client or not voice_client.is_connected():
            return
        
        # Handle loop mode
        if guild_data['loop'] and guild_data['current_song']:
            song = guild_data['current_song']
        else:
            song = await guild_data['queue'].popleft()
        
        if not song:
            guild_data['current_song'] = None
            # Auto-disconnect after 5 minutes of inactivity
            if guild_data['auto_disconnect_task']:
                guild_data['auto_disconnect_task'].cancel()
            
            guild_data['auto_disconnect_task'] = asyncio.create_task(
                self.auto_disconnect(guild, 300)
            )
            return
        
        guild_data['current_song'] = song
        
        try:
            source = discord.FFmpegPCMAudio(song.url, **self.ffmpeg_options)
            
            def after_playing(error):
                if error:
                    logger.error(f'Player error: {error}')
                
                asyncio.run_coroutine_threadsafe(
                    self.play_next(guild), 
                    self.bot.loop
                )
            
            voice_client.play(source, after=after_playing)
            
            # Send now playing embed
            if guild_data['text_channel']:
                embed = self.create_now_playing_embed(song, len(guild_data['queue']))
                await guild_data['text_channel'].send(embed=embed)
                
        except Exception as e:
            logger.error(f"Playback error: {e}")
            await self.play_next(guild)
    
    async def auto_disconnect(self, guild, delay):
        """Auto-disconnect after inactivity"""
        await asyncio.sleep(delay)
        voice_client = guild.voice_client
        
        if voice_client and voice_client.is_connected() and not voice_client.is_playing():
            await voice_client.disconnect()
            
            guild_data = self.guilds_data[guild.id]
            if guild_data['text_channel']:
                embed = discord.Embed(
                    title="Tự Động Ngắt Kết Nối",
                    description="Đã rời kênh voice do không hoạt động",
                    color=0x808080
                )
                await guild_data['text_channel'].send(embed=embed)
    
    def create_now_playing_embed(self, song: Song, queue_length: int):
        """Create beautiful now playing embed with Vietnamese text"""
        embed = discord.Embed(
            title="Đang Phát",
            description=f"**{song.title}**",
            color=0x00ff88
        )
        
        embed.add_field(name="Nghệ sĩ", value=song.uploader, inline=True)
        embed.add_field(name="Thời lượng", value=song.duration, inline=True)
        embed.add_field(name="Hàng đợi", value=f"{queue_length} bài hát", inline=True)
        embed.add_field(name="Được yêu cầu bởi", value=song.requester, inline=True)
        
        if song.thumbnail:
            embed.set_thumbnail(url=song.thumbnail)
        
        if song.webpage_url:
            embed.add_field(name="Nguồn", value=f"[YouTube]({song.webpage_url})", inline=False)
        
        embed.set_footer(text="Thưởng thức nhạc!", icon_url=self.bot.user.avatar.url if self.bot.user.avatar else None)
        return embed

class WeatherService:
    """Weather service with Vietnam city support"""
    
    def __init__(self):
        self.api_key = OPENWEATHER_API_KEY
        self.base_url = "http://api.openweathermap.org/data/2.5"
        self.cache = {}
        self.cache_duration = 600  # 10 minutes
    
    async def get_weather(self, city: str, session: aiohttp.ClientSession) -> Optional[WeatherData]:
        """Get weather data with caching"""
        cache_key = city.lower()
        current_time = time.time()
        
        if cache_key in self.cache:
            cached_data, timestamp = self.cache[cache_key]
            if current_time - timestamp < self.cache_duration:
                return cached_data
        
        try:
            url = f"{self.base_url}/weather"
            params = {
                'q': f"{city},VN",
                'appid': self.api_key,
                'units': 'metric'
            }
            
            async with session.get(url, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    
                    weather_data = WeatherData(
                        city=data['name'],
                        temperature=round(data['main']['temp'], 1),
                        feels_like=round(data['main']['feels_like'], 1),
                        humidity=data['main']['humidity'],
                        description=data['weather'][0]['description'].title(),
                        wind_speed=round(data['wind']['speed'], 1),
                        icon=data['weather'][0]['icon']
                    )
                    
                    # Cache the result
                    self.cache[cache_key] = (weather_data, current_time)
                    return weather_data
                
        except Exception as e:
            logger.error(f"Weather API error: {e}")
        
        return None
    
    def create_weather_embed(self, weather: WeatherData):
        """Create beautiful weather embed with Vietnamese text"""
        embed = discord.Embed(
            title=f"Thời Tiết tại {weather.city}",
            color=0x87CEEB
        )
        
        embed.add_field(name="Nhiệt độ", value=f"{weather.temperature}°C", inline=True)
        embed.add_field(name="Cảm giác như", value=f"{weather.feels_like}°C", inline=True)
        embed.add_field(name="Độ ẩm", value=f"{weather.humidity}%", inline=True)
        embed.add_field(name="Gió", value=f"{weather.wind_speed} m/s", inline=True)
        embed.add_field(name="Tình trạng", value=weather.description, inline=True)
        embed.add_field(name="Quốc gia", value="Việt Nam", inline=True)
        
        embed.set_thumbnail(url=f"http://openweathermap.org/img/wn/{weather.icon}@2x.png")
        embed.set_footer(text="Dữ liệu từ OpenWeatherMap")
        
        return embed

class AIService:
    """Gemini AI integration service"""
    
    def __init__(self):
        self.api_key = GEMINI_API_KEY
        self.base_url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent"
    
    async def get_ai_response(self, prompt: str, session: aiohttp.ClientSession) -> Optional[str]:
        """Get AI response from Gemini with Vietnamese context"""
        try:
            headers = {
                'Content-Type': 'application/json',
            }
            
            # Add Vietnamese context to the prompt
            enhanced_prompt = f"""Bạn là một AI assistant thân thiện, trả lời bằng tiếng Việt.
            
Câu hỏi của người dùng: {prompt}

Hãy trả lời một cách tự nhiên, thân thiện và hữu ích bằng tiếng Việt."""
            
            data = {
                "contents": [{
                    "parts": [{
                        "text": enhanced_prompt
                    }]
                }]
            }
            
            url = f"{self.base_url}?key={self.api_key}"
            
            async with session.post(url, headers=headers, json=data) as response:
                if response.status == 200:
                    result = await response.json()
                    return result['candidates'][0]['content']['parts'][0]['text']
                else:
                    logger.error(f"AI API error: {response.status}")
                    
        except Exception as e:
            logger.error(f"AI API error: {e}")
        
        return None

# Bot setup with optimized intents
intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents, case_insensitive=True)

# Initialize services
music_player = MusicPlayer(bot)
weather_service = WeatherService()
ai_service = AIService()

# FIXED: Autocomplete function for cities
async def city_autocomplete(interaction: discord.Interaction, current: str) -> List[app_commands.Choice[str]]:
    """Async autocomplete function for Vietnam cities"""
    return [
        app_commands.Choice(name=city, value=city)
        for city in VIETNAM_CITIES
        if current.lower() in city.lower()
    ][:25]

@bot.event
async def on_ready():
    """Enhanced bot ready event"""
    try:
        synced = await bot.tree.sync()
        logger.info(f"Bot đã online! Đã đồng bộ {len(synced)} lệnh")
        
        # Set rich presence
        activity = discord.Activity(
            type=discord.ActivityType.listening,
            name="Nhạc chill| /help"
        )
        await bot.change_presence(
            status=discord.Status.online,
            activity=activity
        )
        
        # Start cleanup task
        cleanup_cache.start()
        
        print(f"""
╔══════════════════════════════════════╗
║               DISCORD BOT           ║
║              Đã sẵn sàng!             ║
║                                      ║
║  ✅ Nhạc (Music)                     ║    
║  ✅ Thời tiết Việt Nam               ║
║  ✅ AI Tiếng Việt                    ║
║  ✅ {len(synced)} lệnh đã đồng bộ              ║
╚══════════════════════════════════════╝
        """)
        
    except Exception as e:
        logger.error(f"Setup error: {e}")

@bot.event
async def on_member_join(member):
    """Welcome new members with Vietnamese"""
    if member.guild.system_channel:
        embed = discord.Embed(
            title="Chào mừng đến với server!",
            description=f"Xin chào {member.mention}! Chào mừng bạn đến với **{member.guild.name}**!\n"
                       f"Gõ `/help` để xem tất cả các lệnh có sẵn.",
            color=0x00ff88
        )
        embed.set_thumbnail(url=member.avatar.url if member.avatar else member.default_avatar.url)
        embed.set_footer(text="Chúc bạn có trải nghiệm vui vẻ!")
        
        await member.guild.system_channel.send(embed=embed)

@bot.event
async def on_member_remove(member):
    """Goodbye message in Vietnamese"""
    if member.guild.system_channel:
        embed = discord.Embed(
            title="Tạm biệt!",
            description=f"**{member.display_name}** đã rời server. Hẹn gặp lại!",
            color=0xff6b6b
        )
        embed.set_footer(text="Chúng tôi sẽ nhớ bạn!")
        
        await member.guild.system_channel.send(embed=embed)

@tasks.loop(hours=1)
async def cleanup_cache():
    """Clean up old cache entries"""
    try:
        # Clean music cache
        if len(music_player.ydl_cache) > 100:
            items = list(music_player.ydl_cache.items())
            music_player.ydl_cache = dict(items[-50:])
        
        # Clean weather cache
        current_time = time.time()
        expired_keys = [
            key for key, (_, timestamp) in weather_service.cache.items()
            if current_time - timestamp > weather_service.cache_duration
        ]
        for key in expired_keys:
            del weather_service.cache[key]
            
        logger.info("Cache cleaned up successfully")
            
    except Exception as e:
        logger.error(f"Cache cleanup error: {e}")

# Music Commands
@bot.tree.command(name="play", description="Phát nhạc hoặc thêm vào hàng đợi")
@app_commands.describe(query="Tên bài hát hoặc URL YouTube")
async def play(interaction: discord.Interaction, query: str):
    await interaction.response.defer()
    
    if not interaction.user.voice or not interaction.user.voice.channel:
        embed = discord.Embed(
            title="Chưa Vào Kênh Voice",
            description="Bạn cần vào một kênh voice trước!",
            color=0xff6b6b
        )
        return await interaction.followup.send(embed=embed, ephemeral=True)
    
    # Search for song
    song = await music_player.search_song(query, interaction.user.display_name)
    
    if not song:
        embed = discord.Embed(
            title="Không Tìm Thấy Bài Hát",
            description=f"Không tìm thấy: **{query}**",
            color=0xff6b6b
        )
        return await interaction.followup.send(embed=embed, ephemeral=True)
    
    # Connect to voice if needed
    voice_client = interaction.guild.voice_client
    if not voice_client:
        try:
            voice_client = await interaction.user.voice.channel.connect()
        except Exception as e:
            embed = discord.Embed(
                title="Lỗi Kết Nối",
                description="Không thể kết nối đến kênh voice!",
                color=0xff6b6b
            )
            return await interaction.followup.send(embed=embed, ephemeral=True)
    elif voice_client.channel != interaction.user.voice.channel:
        await voice_client.move_to(interaction.user.voice.channel)
    
    # Set text channel for updates
    music_player.guilds_data[interaction.guild.id]['text_channel'] = interaction.channel
    
    # Add to queue
    await music_player.guilds_data[interaction.guild.id]['queue'].append(song)
    
    # Start playing if nothing is playing
    if not voice_client.is_playing():
        await music_player.play_next(interaction.guild)
        embed = discord.Embed(
            title="Đang Phát",
            description=f"**{song.title}**",
            color=0x00ff88
        )
    else:
        queue_length = len(music_player.guilds_data[interaction.guild.id]['queue'])
        embed = discord.Embed(
            title="Đã Thêm Vào Hàng Đợi",
            description=f"**{song.title}**\nVị trí: #{queue_length}",
            color=0x00ff88
        )
    
    embed.set_thumbnail(url=song.thumbnail)
    embed.add_field(name="Nghệ sĩ", value=song.uploader, inline=True)
    embed.add_field(name="Thời lượng", value=song.duration, inline=True)
    embed.set_footer(text=f"Yêu cầu bởi {song.requester}")
    
    await interaction.followup.send(embed=embed)

@bot.tree.command(name="skip", description="Bỏ qua bài hát hiện tại")
async def skip(interaction: discord.Interaction):
    voice_client = interaction.guild.voice_client
    
    if not voice_client or not voice_client.is_playing():
        embed = discord.Embed(
            title="Không Có Gì Để Bỏ Qua",
            description="Hiện tại không có bài hát nào đang phát!",
            color=0xff6b6b
        )
        return await interaction.response.send_message(embed=embed, ephemeral=True)
    
    voice_client.stop()
    
    embed = discord.Embed(
        title="Đã Bỏ Qua",
        description="Chuyển đến bài hát tiếp theo...",
        color=0x00ff88
    )
    await interaction.response.send_message(embed=embed)

@bot.tree.command(name="queue", description="Hiển thị hàng đợi nhạc")
async def queue_command(interaction: discord.Interaction):
    guild_data = music_player.guilds_data[interaction.guild.id]
    queue_items = await guild_data['queue'].list_items(10)
    
    if not queue_items:
        embed = discord.Embed(
            title="Hàng Đợi Trống",
            description="Không có bài hát nào trong hàng đợi. Sử dụng `/play` để thêm nhạc!",
            color=0x808080
        )
        return await interaction.response.send_message(embed=embed)
    
    embed = discord.Embed(
        title="Hàng Đợi Nhạc",
        color=0x00ff88
    )
    
    queue_text = []
    for i, song in enumerate(queue_items, 1):
        queue_text.append(f"`{i}.` **{song.title}** - `{song.duration}`")
    
    embed.description = "\n".join(queue_text)
    
    total_songs = len(guild_data['queue'])
    if total_songs > 10:
        embed.set_footer(text=f"Hiển thị 10 trong {total_songs} bài hát")
    else:
        embed.set_footer(text=f"Tổng cộng: {total_songs} bài hát")
    
    await interaction.response.send_message(embed=embed)

@bot.tree.command(name="stop", description="Dừng nhạc và ngắt kết nối")
async def stop(interaction: discord.Interaction):
    voice_client = interaction.guild.voice_client
    
    if not voice_client:
        embed = discord.Embed(
            title="Chưa Kết Nối",
            description="Tôi không ở trong kênh voice nào!",
            color=0xff6b6b
        )
        return await interaction.response.send_message(embed=embed, ephemeral=True)
    
    # Clear queue and stop
    await music_player.guilds_data[interaction.guild.id]['queue'].clear()
    music_player.guilds_data[interaction.guild.id]['current_song'] = None
    
    if voice_client.is_playing():
        voice_client.stop()
    
    await voice_client.disconnect()
    
    embed = discord.Embed(
        title="Đã Dừng",
        description="Đã dừng nhạc và ngắt kết nối!",
        color=0x808080
    )
    await interaction.response.send_message(embed=embed)

@bot.tree.command(name="loop", description="Bật/tắt chế độ lặp lại")
async def loop_command(interaction: discord.Interaction):
    guild_data = music_player.guilds_data[interaction.guild.id]
    guild_data['loop'] = not guild_data['loop']
    
    status = "Bật" if guild_data['loop'] else "Tắt"
    embed = discord.Embed(
        title=f"{status} Chế Độ Lặp",
        description=f"Chế độ lặp lại đã được **{'bật' if guild_data['loop'] else 'tắt'}**",
        color=0x00ff88 if guild_data['loop'] else 0x808080
    )
    
    await interaction.response.send_message(embed=embed)

@bot.tree.command(name="nowplaying", description="Hiển thị bài hát đang phát")
async def nowplaying(interaction: discord.Interaction):
    guild_data = music_player.guilds_data[interaction.guild.id]
    current_song = guild_data['current_song']
    
    if not current_song:
        embed = discord.Embed(
            title="Không Có Nhạc",
            description="Hiện tại không có bài hát nào đang phát!",
            color=0xff6b6b
        )
        return await interaction.response.send_message(embed=embed, ephemeral=True)
    
    embed = music_player.create_now_playing_embed(current_song, len(guild_data['queue']))
    await interaction.response.send_message(embed=embed)

# Weather Commands
@bot.tree.command(name="weather", description="Get weather for Vietnam cities")
@app_commands.describe(city="City name (Vietnam)")
@app_commands.autocomplete(city=city_autocomplete)  # Fixed: Use the async function
async def weather(interaction: discord.Interaction, city: str):
    await interaction.response.defer()
    
    async with aiohttp.ClientSession() as session:
        weather_data = await weather_service.get_weather(city, session)
    
    if not weather_data:
        embed = discord.Embed(
            title="Weather Not Found",
            description=f"Couldn't get weather for **{city}**\nTry: {', '.join(VIETNAM_CITIES[:5])}...",
            color=0xff6b6b
        )
        return await interaction.followup.send(embed=embed, ephemeral=True)
    
    embed = weather_service.create_weather_embed(weather_data)
    await interaction.followup.send(embed=embed)

@bot.tree.command(name="weather_vietnam", description="Popular Vietnam cities weather")
async def weather_vietnam(interaction: discord.Interaction):
    await interaction.response.defer()
    
    popular_cities = ["Ho Chi Minh City", "Hanoi", "Da Nang", "Can Tho"]
    
    embed = discord.Embed(
        title="Vietnam Weather Overview",
        color=0x87CEEB
    )
    
    async with aiohttp.ClientSession() as session:
        for city in popular_cities:
            weather_data = await weather_service.get_weather(city, session)
            if weather_data:
                embed.add_field(
                    name=f"{weather_data.city}",
                    value=f"{weather_data.temperature}°C • {weather_data.description}",
                    inline=True
                )
    
    embed.set_footer(text="Use /weather [city] for detailed info")
    await interaction.followup.send(embed=embed)

# AI Commands
@bot.tree.command(name="ask", description="Ask AI anything")
@app_commands.describe(question="Your question for AI")
async def ask_ai(interaction: discord.Interaction, question: str):
    await interaction.response.defer()
    
    async with aiohttp.ClientSession() as session:
        ai_response = await ai_service.get_ai_response(question, session)
    
    if not ai_response:
        embed = discord.Embed(
            title="AI Error",
            description="Sorry, I couldn't process your question right now.",
            color=0xff6b6b
        )
        return await interaction.followup.send(embed=embed, ephemeral=True)
    
    # Truncate if too long
    if len(ai_response) > 2000:
        ai_response = ai_response[:1900] + "... (truncated)"
    
    embed = discord.Embed(
        title="AI Response",
        description=ai_response,
        color=0x00ff88
    )
    embed.set_footer(text=f"Question by {interaction.user.display_name}")
    
    await interaction.followup.send(embed=embed)

# Utility Commands
@bot.tree.command(name="help", description="Show all commands")
async def help_command(interaction: discord.Interaction):
    embed = discord.Embed(
        title="Bot Commands",
        description="Here are all available commands:",
        color=0x00ff88
    )
    
    music_commands = [
        "`/play [song]` - Play music",
        "`/skip` - Skip current song",
        "`/queue` - Show queue",
        "`/stop` - Stop and disconnect",
        "`/loop` - Toggle loop mode",
        "`/nowplaying` - Show current song"
    ]
    
    weather_commands = [
        "`/weather [city]` - Get weather",
        "`/weather_vietnam` - Vietnam overview"
    ]
    
    ai_commands = [
        "`/ask [question]` - Ask AI anything"
    ]
    
    embed.add_field(name="Music", value="\n".join(music_commands), inline=False)
    embed.add_field(name="Weather", value="\n".join(weather_commands), inline=False)
    embed.add_field(name="AI", value="\n".join(ai_commands), inline=False)
    
    embed.set_footer(text="Made with love for Vietnam")
    
    await interaction.response.send_message(embed=embed)

@bot.tree.command(name="ping", description="Check bot latency")
async def ping(interaction: discord.Interaction):
    latency = round(bot.latency * 1000)
    
    embed = discord.Embed(
        title="Pong!",
        description=f"Latency: **{latency}ms**",
        color=0x00ff88 if latency < 100 else 0xffff00 if latency < 200 else 0xff6b6b
    )
    
    await interaction.response.send_message(embed=embed)

# Error handling
@bot.event
async def on_app_command_error(interaction: discord.Interaction, error):
    logger.error(f"Command error: {error}")
    
    if not interaction.response.is_done():
        embed = discord.Embed(
            title="Error",
            description="An error occurred while processing your command.",
            color=0xff6b6b
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

if __name__ == "__main__":
    try:
        bot.run(DISCORD_TOKEN)
    except Exception as e:
        logger.error(f"Bot startup error: {e}")
        print(f"Failed to start bot: {e}")
        print("Make sure to set your DISCORD_TOKEN!")