const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType, demuxProbe } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytsr = require('ytsr');
const axios = require('axios');
const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Config từ .env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const WELCOME_CHANNEL_ID = '💬𝓒𝓱𝓪𝓽';
const AUTO_ROLE_NAME = '🦄 AKKA LOO';
const PORT = process.env.PORT || 3000;

// FFmpeg path configuration - Fix path cho Windows
const FFMPEG_PATH = process.platform === 'win32' 
    ? path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg.exe')
    : 'ffmpeg'; // Linux/Mac sử dụng system ffmpeg

// Express app setup
const app = express();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
});

// Health check endpoints
app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running! 🤖',
        uptime: `${Math.floor(process.uptime())} seconds`,
        timestamp: new Date().toISOString(),
        bot_status: client.isReady() ? 'online' : 'starting...',
        guilds: client.isReady() ? client.guilds.cache.size : 0,
        ffmpeg_status: checkFFmpegAvailable() ? 'available' : 'system'
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        bot_status: client.isReady() ? 'online' : 'offline',
        guilds: client.guilds.cache.size,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        ffmpeg_available: checkFFmpegAvailable()
    });
});

// Music queue system
const queue = new Map();

// Slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('weather')
        .setDescription('Xem thời tiết')
        .addStringOption(option =>
            option.setName('city')
                .setDescription('Tên thành phố (VD: Ho Chi Minh City, Go Vap)')
                .setRequired(true)
        ),
    
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Phát nhạc từ YouTube')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Link YouTube hoặc tên bài hát')
                .setRequired(true)
        ),
    
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Dừng nhạc và rời voice channel'),
    
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Bỏ qua bài hiện tại'),
    
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Xem danh sách phát'),
    
    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Tạm dừng nhạc'),
    
    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Tiếp tục phát nhạc'),
    
    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Xem bài đang phát'),
    
    new SlashCommandBuilder()
        .setName('ffmpeg')
        .setDescription('Kiểm tra trạng thái FFmpeg')
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function deployCommands() {
    try {
        console.log('🔄 Đang đăng ký slash commands...');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands }
        );
        console.log('✅ Đã đăng ký thành công slash commands!');
    } catch (error) {
        console.error('❌ Lỗi khi đăng ký commands:', error);
    }
}

// Check FFmpeg availability - Fixed function
function checkFFmpegAvailable() {
    if (process.platform === 'win32') {
        return fs.existsSync(FFMPEG_PATH);
    }
    // For Linux/Mac, assume ffmpeg is available in PATH
    return true;
}

// Weather function
async function getWeather(city) {
    try {
        const cityMap = {
            'hcm': 'Ho Chi Minh City',
            'tphcm': 'Ho Chi Minh City',
            'tp hcm': 'Ho Chi Minh City',
            'go vap': 'Go Vap',
            'gò vấp': 'Go Vap',
            'ha noi': 'Hanoi',
            'hà nội': 'Hanoi',
            'da nang': 'Da Nang',
            'đà nẵng': 'Da Nang',
            'can tho': 'Can Tho',
            'cần thơ': 'Can Tho'
        };
        
        const searchCity = cityMap[city.toLowerCase()] || city;
        
        const response = await axios.get(
            `https://api.openweathermap.org/data/2.5/weather?q=${searchCity},VN&appid=${OPENWEATHER_API_KEY}&units=metric&lang=vi`
        );
        
        const weather = response.data;
        
        const embed = new EmbedBuilder()
            .setTitle(`🌤️ Thời tiết tại ${weather.name}`)
            .setColor('#00ff00')
            .addFields(
                { name: '🌡️ Nhiệt độ', value: `${Math.round(weather.main.temp)}°C`, inline: true },
                { name: '🌡️ Cảm giác như', value: `${Math.round(weather.main.feels_like)}°C`, inline: true },
                { name: '💧 Độ ẩm', value: `${weather.main.humidity}%`, inline: true },
                { name: '☁️ Mô tả', value: weather.weather[0].description, inline: true },
                { name: '💨 Tốc độ gió', value: `${weather.wind.speed} m/s`, inline: true },
                { name: '👁️ Tầm nhìn', value: `${weather.visibility/1000} km`, inline: true }
            )
            .setFooter({ text: '🇻🇳 Dữ liệu từ OpenWeatherMap' })
            .setTimestamp();
            
        return embed;
    } catch (error) {
        console.error('❌ Lỗi khi lấy thời tiết:', error);
        return new EmbedBuilder()
            .setTitle('❌ Lỗi')
            .setDescription('Không thể lấy thông tin thời tiết. Vui lòng kiểm tra tên thành phố!')
            .setColor('#ff0000');
    }
}

// FIXED Music functions with better error handling
async function playMusic(guild, song) {
    const serverQueue = queue.get(guild.id);
    
    if (!song) {
        if (serverQueue && serverQueue.connection) {
            serverQueue.connection.destroy();
        }
        queue.delete(guild.id);
        return serverQueue?.textChannel?.send('✅ Đã phát hết nhạc trong hàng đợi!');
    }
    
    try {
        console.log(`🎵 Đang chuẩn bị phát: ${song.title}`);
        
        // Enhanced ytdl options to handle 410 errors
        const ytdlOptions = {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
            liveBuffer: 1 << 25,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            }
        };

        // Validate URL again before creating stream
        if (!ytdl.validateURL(song.url)) {
            throw new Error('URL không hợp lệ hoặc video không khả dụng');
        }

        // Check if video is available
        const info = await ytdl.getBasicInfo(song.url);
        if (info.videoDetails.isLiveContent) {
            throw new Error('Không thể phát livestream');
        }

        // Create stream with retry mechanism
        let stream;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                stream = ytdl(song.url, ytdlOptions);
                break;
            } catch (err) {
                retryCount++;
                console.log(`⚠️ Lần thử ${retryCount}/${maxRetries} thất bại: ${err.message}`);
                
                if (retryCount >= maxRetries) {
                    throw new Error(`Không thể tạo stream sau ${maxRetries} lần thử: ${err.message}`);
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }

        // Probe the stream to get its type
        const { stream: probedStream, type } = await demuxProbe(stream);
        
        // Create audio resource với stream đã probe
        const resource = createAudioResource(probedStream, {
            inputType: type,
            metadata: {
                title: song.title,
                url: song.url
            }
        });
        
        const player = createAudioPlayer();
        serverQueue.player = player;
        serverQueue.resource = resource;
        
        // Subscribe player to connection
        serverQueue.connection.subscribe(player);
        
        // Play the resource
        player.play(resource);
        
        console.log('🎵 Đã bắt đầu phát nhạc!');
        
        // Player event handlers - Fixed
        player.on(AudioPlayerStatus.Playing, () => {
            console.log('✅ Nhạc đang phát successfully!');
        });
        
        player.on(AudioPlayerStatus.Idle, () => {
            console.log('⏭️ Bài hát kết thúc, chuyển bài tiếp theo...');
            serverQueue.songs.shift();
            setTimeout(() => {
                playMusic(guild, serverQueue.songs[0]);
            }, 500);
        });
        
        player.on('error', error => {
            console.error('❌ Player error:', error);
            serverQueue.textChannel?.send(`❌ Lỗi khi phát "${song.title}"! Chuyển bài tiếp theo...`);
            serverQueue.songs.shift();
            setTimeout(() => {
                playMusic(guild, serverQueue.songs[0]);
            }, 1000);
        });
        
        // Send now playing message
        const nowPlayingEmbed = new EmbedBuilder()
            .setTitle('🎵 Đang phát')
            .setDescription(`**${song.title}**`)
            .addFields(
                { name: '🎤 Kênh', value: song.channel || 'Không rõ', inline: true },
                { name: '⏱️ Thời gian', value: song.duration || 'Không rõ', inline: true },
                { name: '🔗 Link', value: `[YouTube](${song.url})`, inline: true }
            )
            .setColor('#00ff00')
            .setTimestamp();
            
        if (song.thumbnail) {
            nowPlayingEmbed.setThumbnail(song.thumbnail);
        }
        
        serverQueue.textChannel?.send({ embeds: [nowPlayingEmbed] });
        
    } catch (error) {
        console.error('❌ Lỗi phát nhạc:', error);
        serverQueue?.textChannel?.send(`❌ Không thể phát "${song.title}": ${error.message}`);
        
        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) {
            setTimeout(() => {
                playMusic(guild, serverQueue.songs[0]);
            }, 3000);
        }
    }
}

// Search YouTube function - Enhanced with fallback
async function searchYouTube(query) {
    try {
        console.log(`🔍 Tìm kiếm: ${query}`);
        
        if (ytdl.validateURL(query)) {
            console.log('📺 Lấy thông tin từ URL YouTube...');
            
            // Check if video is available first
            try {
                const info = await ytdl.getBasicInfo(query);
                
                // Check for restrictions
                if (info.videoDetails.isPrivate) {
                    throw new Error('Video này là private');
                }
                
                if (info.videoDetails.isLiveContent) {
                    throw new Error('Không thể phát livestream');
                }
                
                // Check if video is available in region
                if (info.videoDetails.lengthSeconds === '0') {
                    throw new Error('Video không khả dụng hoặc bị hạn chế');
                }
                
                return {
                    title: info.videoDetails.title,
                    url: info.videoDetails.video_url,
                    duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
                    thumbnail: info.videoDetails.thumbnails?.[0]?.url,
                    channel: info.videoDetails.author?.name
                };
                
            } catch (error) {
                if (error.message.includes('410') || error.message.includes('Not available')) {
                    // Try to search for the same video by title
                    console.log('⚠️ Video không khả dụng trực tiếp, thử tìm kiếm thay thế...');
                    
                    // Extract video title from URL if possible
                    const urlTitle = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
                    if (urlTitle) {
                        // Search for alternative
                        return await searchByTitle(info.videoDetails.title || query);
                    }
                }
                throw error;
            }
        } else {
            return await searchByTitle(query);
        }
    } catch (error) {
        console.error('❌ Lỗi tìm kiếm:', error);
        throw new Error(`Không thể tìm thấy bài hát: ${error.message}`);
    }
}

// Helper function to search by title
async function searchByTitle(query) {
    console.log('🔎 Tìm kiếm trên YouTube...');
    
    const searchResults = await ytsr(query, { 
        limit: 5, // Increase limit to have more options
        safeSearch: false 
    });
    
    if (!searchResults || !searchResults.items || searchResults.items.length === 0) {
        throw new Error(`Không tìm thấy kết quả cho: "${query}"`);
    }
    
    const videos = searchResults.items.filter(item => 
        item.type === 'video' && 
        item.duration && 
        item.duration !== 'N/A' &&
        !item.isLive &&
        item.url && 
        ytdl.validateURL(item.url)
    );
    
    if (videos.length === 0) {
        throw new Error('Không tìm thấy video phù hợp!');
    }
    
    // Try each video until we find one that works
    for (const video of videos) {
        try {
            console.log(`🔍 Thử video: ${video.title}`);
            
            // Quick check if video is available
            const info = await ytdl.getBasicInfo(video.url);
            
            if (!info.videoDetails.isPrivate && 
                !info.videoDetails.isLiveContent && 
                info.videoDetails.lengthSeconds !== '0') {
                
                console.log(`✅ Tìm thấy: ${video.title}`);
                
                return {
                    title: video.title,
                    url: video.url,
                    duration: video.duration,
                    thumbnail: video.bestThumbnail?.url,
                    channel: video.author?.name
                };
            }
        } catch (err) {
            console.log(`⚠️ Video không khả dụng: ${video.title}, thử video tiếp theo...`);
            continue;
        }
    }
    
    throw new Error('Tất cả video tìm thấy đều không khả dụng');
}

// Format duration helper
function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'N/A';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Bot events
client.once('ready', async () => {
    console.log(`✅ Bot đã online: ${client.user.tag}`);
    await deployCommands();
    
    // Set activity - Fixed deprecated method
    client.user.setPresence({
        activities: [{ name: '🎵 Nhạc & Thời tiết', type: 2 }], // Type 2 = LISTENING
        status: 'online',
    });
});

// Auto role when member joins
client.on('guildMemberAdd', async (member) => {
    try {
        const role = member.guild.roles.cache.find(r => r.name === AUTO_ROLE_NAME);
        if (role) {
            await member.roles.add(role);
            console.log(`✅ Đã thêm role "${AUTO_ROLE_NAME}" cho ${member.user.tag}`);
        }
        
        const welcomeChannel = member.guild.channels.cache.find(ch => 
            ch.name.includes('chat') || ch.name.includes('💬')
        );
        
        if (welcomeChannel) {
            const embed = new EmbedBuilder()
                .setTitle('🎉 Chào mừng thành viên mới!')
                .setDescription(`Xin chào ${member.user}! Chào mừng bạn đến với server! 🦄`)
                .setColor('#00ff00')
                .setThumbnail(member.user.displayAvatarURL())
                .setTimestamp();
            
            welcomeChannel.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error('❌ Lỗi khi xử lý thành viên mới:', error);
    }
});

// Slash command interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    if (commandName === 'weather') {
        const city = interaction.options.getString('city');
        await interaction.deferReply();
        
        const weatherEmbed = await getWeather(city);
        await interaction.editReply({ embeds: [weatherEmbed] });
    }
    
    else if (commandName === 'ffmpeg') {
        const isAvailable = checkFFmpegAvailable();
        const embed = new EmbedBuilder()
            .setTitle('🎛️ Trạng thái FFmpeg')
            .setColor(isAvailable ? '#00ff00' : '#ff0000')
            .addFields(
                { name: 'Platform', value: process.platform, inline: true },
                { name: 'FFmpeg Status', value: isAvailable ? '✅ Khả dụng' : '❌ Kiểm tra cài đặt', inline: true },
                { name: 'Path', value: FFMPEG_PATH, inline: false }
            )
            .setFooter({ text: 'FFmpeg được sử dụng để xử lý âm thanh' })
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed] });
    }
    
        else if (commandName === 'play') {
        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;
        
        if (!voiceChannel) {
            return interaction.reply('❌ Bạn cần vào voice channel trước!');
        }
        
        // Fixed permission check
        const permissions = voiceChannel.permissionsFor(interaction.client.user);
        if (!permissions.has(['Connect', 'Speak'])) {
            return interaction.reply('❌ Bot không có quyền vào voice channel!');
        }
        
        await interaction.deferReply();
        
        try {
            // Enhanced search with better error handling
            let song;
            try {
                song = await searchYouTube(query);
            } catch (searchError) {
                // If direct search fails, try alternative search terms
                if (searchError.message.includes('410') || searchError.message.includes('Not available')) {
                    const alternatives = [
                        query + ' official',
                        query + ' mv',
                        query.replace(/ft\.|feat\./, 'featuring'),
                        query.split(' ')[0] + ' ' + query.split(' ')[1] // First two words only
                    ];
                    
                    for (const alt of alternatives) {
                        try {
                            console.log(`🔄 Thử tìm kiếm thay thế: ${alt}`);
                            song = await searchYouTube(alt);
                            break;
                        } catch (altError) {
                            continue;
                        }
                    }
                    
                    if (!song) {
                        throw new Error('Không tìm thấy video nào khả dụng. Video có thể bị chặn hoặc hạn chế địa lý.');
                    }
                } else {
                    throw searchError;
                }
            }
            
            let serverQueue = queue.get(interaction.guild.id);
            
            if (!serverQueue) {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                });

                serverQueue = {
                    textChannel: interaction.channel,
                    voiceChannel: voiceChannel,
                    connection: connection,
                    songs: [],
                    player: null,
                };
                queue.set(interaction.guild.id, serverQueue);
                serverQueue.songs.push(song);
                
                // Wait for connection to be ready
                connection.on(VoiceConnectionStatus.Ready, () => {
                    console.log('✅ Đã kết nối voice channel!');
                });

                connection.on(VoiceConnectionStatus.Disconnected, () => {
                    console.log('⚠️ Đã mất kết nối voice channel');
                    queue.delete(interaction.guild.id);
                });

                const embed = new EmbedBuilder()
                    .setTitle('✅ Bắt đầu phát')
                    .setDescription(`**${song.title}**`)
                    .addFields(
                        { name: '🎤 Kênh', value: song.channel || 'Không rõ', inline: true },
                        { name: '⏱️ Thời gian', value: song.duration || 'Không rõ', inline: true },
                        { name: '📍 Vị trí', value: '#1 (Đang phát)', inline: true }
                    )
                    .setColor('#00ff00')
                    .setTimestamp();
                if (song.thumbnail) embed.setThumbnail(song.thumbnail);
                
                await interaction.editReply({ embeds: [embed] });
                
                // Start playing after a short delay
                setTimeout(() => {
                    playMusic(interaction.guild, serverQueue.songs[0]);
                }, 1000);
                
            } else {
                serverQueue.songs.push(song);
                const embed = new EmbedBuilder()
                    .setTitle('✅ Đã thêm vào hàng đợi')
                    .setDescription(`**${song.title}**`)
                    .addFields(
                        { name: '📍 Vị trí', value: `#${serverQueue.songs.length}`, inline: true },
                        { name: '🎤 Kênh', value: song.channel || 'Không rõ', inline: true },
                        { name: '⏱️ Thời gian', value: song.duration || 'Không rõ', inline: true }
                    )
                    .setColor('#00ff00')
                    .setTimestamp();
                if (song.thumbnail) embed.setThumbnail(song.thumbnail);
                
                await interaction.editReply({ embeds: [embed] });
            }
            
        } catch (error) {
            console.error('❌ Play command error:', error);
            
            let errorMessage = error.message;
            let suggestions = [];
            
            if (error.message.includes('410')) {
                errorMessage = 'Video không khả dụng (có thể bị chặn hoặc hạn chế địa lý)';
                suggestions = [
                    '• Thử tìm kiếm bằng tên bài hát thay vì link',
                    '• Thử từ khóa khác (VD: "Hãy trao cho anh Sơn Tùng")',
                    '• Video có thể bị chặn ở Việt Nam'
                ];
            } else if (error.message.includes('private')) {
                errorMessage = 'Video này là private hoặc đã bị xóa';
                suggestions = ['• Thử tìm kiếm bản khác của bài hát'];
            } else if (error.message.includes('livestream')) {
                errorMessage = 'Không thể phát livestream';
                suggestions = ['• Bot chỉ phát được video đã ghi sẵn'];
            } else {
                suggestions = [
                    '• Kiểm tra link YouTube',
                    '• Thử tìm kiếm bằng tên bài hát',
                    '• Đảm bảo video không bị chặn'
                ];
            }
            
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('❌ Không thể phát nhạc')
                    .setDescription(errorMessage)
                    .addFields({ 
                        name: '💡 Gợi ý', 
                        value: suggestions.join('\n') || 'Vui lòng thử lại sau'
                    })
                    .setColor('#ff0000')]
            });
        }
    }
    
    else if (commandName === 'stop') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue) {
            return interaction.reply('❌ Không có nhạc nào đang phát!');
        }
        
        if (serverQueue.player) {
            serverQueue.player.stop();
        }
        
        if (serverQueue.connection) {
            serverQueue.connection.destroy();
        }
        
        queue.delete(interaction.guild.id);
        
        await interaction.reply('⏹️ Đã dừng nhạc và rời voice channel!');
    }
    
    else if (commandName === 'skip') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue || !serverQueue.player) {
            return interaction.reply('❌ Không có nhạc nào đang phát!');
        }
        
        serverQueue.player.stop(); // This will trigger the idle event and play next song
        await interaction.reply('⏭️ Đã bỏ qua bài hiện tại!');
    }
    
    else if (commandName === 'pause') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue || !serverQueue.player) {
            return interaction.reply('❌ Không có nhạc nào đang phát!');
        }
        
        if (serverQueue.player.state.status === AudioPlayerStatus.Playing) {
            serverQueue.player.pause();
            await interaction.reply('⏸️ Đã tạm dừng nhạc!');
        } else {
            await interaction.reply('❌ Nhạc không đang phát!');
        }
    }
    
    else if (commandName === 'resume') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue || !serverQueue.player) {
            return interaction.reply('❌ Không có nhạc nào trong hàng đợi!');
        }
        
        if (serverQueue.player.state.status === AudioPlayerStatus.Paused) {
            serverQueue.player.unpause();
            await interaction.reply('▶️ Đã tiếp tục phát nhạc!');
        } else {
            await interaction.reply('❌ Nhạc không bị tạm dừng!');
        }
    }
    
    else if (commandName === 'nowplaying') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue || serverQueue.songs.length === 0) {
            return interaction.reply('❌ Không có nhạc nào đang phát!');
        }
        
        const currentSong = serverQueue.songs[0];
        const embed = new EmbedBuilder()
            .setTitle('🎵 Đang phát')
            .setDescription(`**${currentSong.title}**`)
            .addFields(
                { name: '🎤 Kênh', value: currentSong.channel || 'Không rõ', inline: true },
                { name: '⏱️ Thời gian', value: currentSong.duration || 'Không rõ', inline: true },
                { name: '🔗 Link', value: `[YouTube](${currentSong.url})`, inline: true }
            )
            .setColor('#00ff00')
            .setTimestamp();
            
        if (currentSong.thumbnail) {
            embed.setThumbnail(currentSong.thumbnail);
        }
        
        await interaction.reply({ embeds: [embed] });
    }
    
    else if (commandName === 'queue') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue || serverQueue.songs.length === 0) {
            return interaction.reply('❌ Hàng đợi trống!');
        }
        
        const embed = new EmbedBuilder()
            .setTitle('🎵 Danh sách phát')
            .setColor('#00ff00');
        
        const queueList = serverQueue.songs.slice(0, 10).map((song, index) => {
            const status = index === 0 ? '🎵 **Đang phát**' : `${index}.`;
            return `${status} ${song.title} - \`${song.duration}\``;
        }).join('\n');
        
        embed.setDescription(queueList || 'Trống');
        
        if (serverQueue.songs.length > 10) {
            embed.setFooter({ text: `Và ${serverQueue.songs.length - 10} bài khác...` });
        }
        
        await interaction.reply({ embeds: [embed] });
    }
});

// Error handling
client.on('error', (error) => {
    console.error('❌ Client error:', error);
});

// Keep alive function
function keepAlive() {
    setInterval(() => {
        console.log('💚 Bot is alive! ' + new Date().toLocaleString('vi-VN'));
        console.log(`🎛️ FFmpeg Status: ${checkFFmpegAvailable() ? 'Available' : 'System'}`);
        console.log(`🎵 Active queues: ${queue.size}`);
    }, 5 * 60 * 1000); // 5 phút
}

// Anti-crash - Enhanced
process.on('unhandledRejection', (reason, promise) => {
    console.log('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.log('❌ Uncaught Exception:', err);
    // Don't exit on uncaught exceptions in production
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT. Gracefully shutting down...');
    client.destroy();
    process.exit(0);
});

// Start HTTP Server
app.listen(PORT, () => {
    console.log(`🌐 HTTP Server đang chạy trên port ${PORT}`);
});

// Login với retry - Enhanced
async function login() {
    try {
        await client.login(DISCORD_TOKEN);
        keepAlive();
        console.log('✅ Bot đã login thành công!');
    } catch (error) {
        console.error('❌ Lỗi login:', error);
        console.log('🔄 Thử lại sau 10 giây...');
        setTimeout(login, 10000); // Retry sau 10s
    }
}

// Khởi động bot
console.log('🚀 Đang khởi động Discord Music Bot...');
console.log(`🎛️ Platform: ${process.platform}`);
console.log(`🎛️ FFmpeg Available: ${checkFFmpegAvailable()}`);
login();