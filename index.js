const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, demuxProbe } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytsr = require('ytsr');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

// Config từ .env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const WELCOME_CHANNEL_ID = '💬𝓒𝓱𝓪𝓽';
const AUTO_ROLE_NAME = '🦄 AKKA LOO';
const PORT = process.env.PORT || 3000;

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
        guilds: client.isReady() ? client.guilds.cache.size : 0
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        bot_status: client.isReady() ? 'online' : 'offline',
        guilds: client.guilds.cache.size,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

app.get('/ping', (req, res) => {
    res.send('Pong! 🏓');
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
        .setDescription('Xem bài đang phát')
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function deployCommands() {
    try {
        console.log('Đang đăng ký slash commands...');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands }
        );
        console.log('✅ Đã đăng ký thành công slash commands!');
    } catch (error) {
        console.error('❌ Lỗi khi đăng ký commands:', error);
    }
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
        console.error('Lỗi khi lấy thời tiết:', error);
        return new EmbedBuilder()
            .setTitle('❌ Lỗi')
            .setDescription('Không thể lấy thông tin thời tiết. Vui lòng kiểm tra tên thành phố!')
            .setColor('#ff0000');
    }
}

// Music functions
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
        
        // Kiểm tra lại URL trước khi phát
        if (!ytdl.validateURL(song.url)) {
            throw new Error('URL không hợp lệ!');
        }
        
        // Tạo stream từ ytdl với các options tối ưu
        const stream = ytdl(song.url, {
            filter: 'audioonly',
            highWaterMark: 1 << 25,
            quality: 'highestaudio',
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            }
        });
        
        const resource = createAudioResource(stream, {
            inlineVolume: true
        });
        
        // Set volume
        resource.volume?.setVolume(0.5);
        
        const player = createAudioPlayer();
        serverQueue.player = player;
        serverQueue.resource = resource;
        
        player.play(resource);
        serverQueue.connection.subscribe(player);
        
        // Player events
        player.on(AudioPlayerStatus.Playing, () => {
            console.log('✅ Nhạc đang phát!');
        });
        
        player.on(AudioPlayerStatus.Idle, () => {
            console.log('⏭️ Bài hát kết thúc, chuyển bài tiếp theo...');
            serverQueue.songs.shift();
            setTimeout(() => {
                playMusic(guild, serverQueue.songs[0]);
            }, 1000);
        });
        
        player.on('error', error => {
            console.error('❌ Player error:', error);
            serverQueue.textChannel?.send(`❌ Lỗi khi phát "${song.title}"! Chuyển bài tiếp theo...`);
            serverQueue.songs.shift();
            setTimeout(() => {
                playMusic(guild, serverQueue.songs[0]);
            }, 2000);
        });
        
        // Xử lý lỗi stream
        stream.on('error', error => {
            console.error('❌ Stream error:', error);
            serverQueue.textChannel?.send(`❌ Lỗi stream khi phát "${song.title}"! Chuyển bài tiếp theo...`);
            serverQueue.songs.shift();
            setTimeout(() => {
                playMusic(guild, serverQueue.songs[0]);
            }, 2000);
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
        console.error('❌ Play error:', error.message);
        serverQueue?.textChannel?.send(`❌ Không thể phát "${song.title}"! Lỗi: ${error.message}`);
        
        // Thử bài tiếp theo
        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) {
            setTimeout(() => {
                playMusic(guild, serverQueue.songs[0]);
            }, 3000);
        } else {
            serverQueue?.textChannel?.send('❌ Không có bài nào khác để phát!');
            if (serverQueue && serverQueue.connection) {
                serverQueue.connection.destroy();
            }
            queue.delete(guild.id);
        }
    }
}

// Search YouTube
async function searchYouTube(query) {
    try {
        console.log(`🔍 Tìm kiếm: ${query}`);
        
        // Kiểm tra xem có phải URL YouTube không
        if (ytdl.validateURL(query)) {
            console.log('📺 Đang lấy thông tin video từ URL...');
            
            try {
                const info = await ytdl.getInfo(query);
                
                return {
                    title: info.videoDetails.title || 'Unknown Title',
                    url: info.videoDetails.video_url || query,
                    duration: formatDuration(parseInt(info.videoDetails.lengthSeconds) || 0),
                    thumbnail: info.videoDetails.thumbnails?.[0]?.url,
                    channel: info.videoDetails.author?.name || 'Unknown Channel'
                };
            } catch (ytdlError) {
                console.error('❌ ytdl error:', ytdlError.message);
                
                // Fallback: Extract video ID and reconstruct URL
                let videoId = '';
                if (query.includes('v=')) {
                    videoId = query.split('v=')[1].split('&')[0];
                } else if (query.includes('youtu.be/')) {
                    videoId = query.split('youtu.be/')[1].split('?')[0];
                }
                
                if (videoId) {
                    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    const retryInfo = await ytdl.getInfo(cleanUrl);
                    
                    return {
                        title: retryInfo.videoDetails.title || 'Unknown Title',
                        url: cleanUrl,
                        duration: formatDuration(parseInt(retryInfo.videoDetails.lengthSeconds) || 0),
                        thumbnail: retryInfo.videoDetails.thumbnails?.[0]?.url,
                        channel: retryInfo.videoDetails.author?.name || 'Unknown Channel'
                    };
                }
                throw ytdlError;
            }
        } else {
            // Tìm kiếm theo tên bằng ytsr
            console.log('🔎 Đang tìm kiếm trên YouTube...');
            const searchResults = await ytsr(query, { limit: 5 });
            
            if (!searchResults || !searchResults.items || searchResults.items.length === 0) {
                throw new Error(`Không tìm thấy bài hát nào với từ khóa: "${query}"`);
            }
            
            // Lọc chỉ lấy video (không phải playlist hay channel)
            const videos = searchResults.items.filter(item => item.type === 'video' && item.duration);
            
            if (videos.length === 0) {
                throw new Error('Không tìm thấy video nào phù hợp!');
            }
            
            const video = videos[0];
            console.log(`✅ Tìm thấy: ${video.title}`);
            
            return {
                title: video.title || 'Unknown Title',
                url: video.url,
                duration: video.duration || 'Unknown',
                thumbnail: video.bestThumbnail?.url || video.thumbnails?.[0]?.url,
                channel: video.author?.name || 'Unknown Channel'
            };
        }
    } catch (error) {
        console.error('❌ Search error:', error.message);
        throw new Error(`Không thể tìm thấy hoặc phát bài hát này! Lỗi: ${error.message}`);
    }
}

// Format duration helper
function formatDuration(seconds) {
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
    client.user.setActivity('🎵 Nhạc & Thời tiết', { type: 'LISTENING' });
});

// Auto role when member joins
client.on('guildMemberAdd', async (member) => {
    try {
        const role = member.guild.roles.cache.find(r => r.name === AUTO_ROLE_NAME);
        if (role) {
            await member.roles.add(role);
            console.log(`✅ Đã thêm role "${AUTO_ROLE_NAME}" cho ${member.user.tag}`);
        }
        
        const welcomeChannel = member.guild.channels.cache.find(ch => ch.name.includes('chat') || ch.name.includes('💬'));
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
        console.error('Lỗi khi xử lý thành viên mới:', error);
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
    
    else if (commandName === 'play') {
        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;
        
        if (!voiceChannel) {
            return interaction.reply('❌ Bạn cần vào voice channel trước!');
        }
        
        await interaction.deferReply();
        
        try {
            console.log(`🎯 Đang xử lý: ${query}`);
            
            // Hiển thị trạng thái đang tìm kiếm
            await interaction.editReply('🔍 Đang tìm kiếm bài hát...');
            
            const song = await searchYouTube(query);
            console.log(`✅ Tìm thấy bài hát: ${song.title}`);
            
            const serverQueue = queue.get(interaction.guild.id);
            
            if (!serverQueue) {
                const queueContruct = {
                    textChannel: interaction.channel,
                    voiceChannel: voiceChannel,
                    connection: null,
                    songs: [],
                    volume: 5,
                    playing: true,
                    player: null,
                    resource: null
                };
                
                queue.set(interaction.guild.id, queueContruct);
                queueContruct.songs.push(song);
                
                try {
                    await interaction.editReply('🔗 Đang kết nối voice channel...');
                    
                    const connection = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: interaction.guild.id,
                        adapterCreator: interaction.guild.voiceAdapterCreator,
                    });
                    
                    queueContruct.connection = connection;
                    
                    // Wait for connection to be ready
                    connection.on(VoiceConnectionStatus.Ready, () => {
                        console.log('✅ Kết nối voice channel thành công!');
                        playMusic(interaction.guild, queueContruct.songs[0]);
                    });
                    
                    connection.on(VoiceConnectionStatus.Disconnected, () => {
                        console.log('⚠️ Mất kết nối voice channel');
                        queue.delete(interaction.guild.id);
                    });
                    
                    connection.on('error', (error) => {
                        console.error('❌ Connection error:', error);
                        queue.delete(interaction.guild.id);
                    });
                    
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Đã thêm vào hàng đợi')
                        .setDescription(`**${song.title}**`)
                        .addFields(
                            { name: '🎤 Kênh', value: song.channel || 'Không rõ', inline: true },
                            { name: '⏱️ Thời gian', value: song.duration || 'Không rõ', inline: true },
                            { name: '📍 Vị trí', value: '#1 (Đang phát)', inline: true }
                        )
                        .setColor('#00ff00')
                        .setTimestamp();
                        
                    if (song.thumbnail) {
                        embed.setThumbnail(song.thumbnail);
                    }
                    
                    await interaction.editReply({ content: null, embeds: [embed] });
                    
                } catch (err) {
                    console.error('❌ Lỗi kết nối voice:', err);
                    queue.delete(interaction.guild.id);
                    await interaction.editReply('❌ Không thể kết nối voice channel!');
                }
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
                    
                if (song.thumbnail) {
                    embed.setThumbnail(song.thumbnail);
                }
                
                await interaction.editReply({ content: null, embeds: [embed] });
            }
            
        } catch (error) {
            console.error('❌ Play command error:', error);
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('❌ Lỗi')
                    .setDescription(error.message)
                    .addFields(
                        { name: '💡 Gợi ý', value: 'Hãy thử:\n• Kiểm tra link YouTube có đúng không\n• Thử tìm kiếm bằng tên bài hát\n• Đảm bảo video không bị chặn ở khu vực của bạn' }
                    )
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
        
        serverQueue.player.stop();
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

client.on('disconnect', () => {
    console.log('⚠️ Bot disconnected, attempting reconnect...');
});

client.on('reconnecting', () => {
    console.log('🔄 Bot reconnecting...');
});

// Keep alive function
function keepAlive() {
    setInterval(() => {
        console.log('💚 Bot is alive! ' + new Date().toLocaleString('vi-VN'));
    }, 5 * 60 * 1000); // 5 phút
}

// Anti-crash
process.on('unhandledRejection', (reason, promise) => {
    console.log('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.log('❌ Uncaught Exception:', err);
});

// Start HTTP Server
app.listen(PORT, () => {
    console.log(`🌐 HTTP Server đang chạy trên port ${PORT}`);
});

// Login với retry
async function login() {
    try {
        await client.login(DISCORD_TOKEN);
        keepAlive();
        console.log('✅ Bot đã login thành công!');
    } catch (error) {
        console.error('❌ Lỗi login:', error);
        setTimeout(login, 5000); // Retry sau 5s
    }
}

login();