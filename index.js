const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
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

// Music functions - FIXED VERSION
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
        console.log(`🔗 URL: ${song.url}`);
        
        // Tạo audio stream với options tối ưu
        const stream = ytdl(song.url, {
            filter: 'audioonly',
            fmt: 'mp4',
            highWaterMark: 1 << 62,
            liveBuffer: 1 << 62,
            dlChunkSize: 0,
            bitrate: 128,
            quality: 'lowestaudio'
        });

        // Tạo audio resource
        const resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
        });
        
        const player = createAudioPlayer();
        serverQueue.player = player;
        serverQueue.resource = resource;
        
        // Subscribe player to connection
        serverQueue.connection.subscribe(player);
        
        // Play the resource
        player.play(resource);
        
        console.log('🎵 Đã bắt đầu phát nhạc!');
        
        // Player event handlers
        player.on(AudioPlayerStatus.Playing, () => {
            console.log('✅ Nhạc đang phát successfully!');
        });
        
        player.on(AudioPlayerStatus.Idle, () => {
            console.log('⏭️ Bài hát kết thúc, chuyển bài tiếp theo...');
            serverQueue.songs.shift();
            playMusic(guild, serverQueue.songs[0]);
        });
        
        player.on('error', error => {
            console.error('❌ Player error:', error);
            serverQueue.textChannel?.send(`❌ Lỗi khi phát "${song.title}"! Chuyển bài tiếp theo...`);
            serverQueue.songs.shift();
            playMusic(guild, serverQueue.songs[0]);
        });
        
        // Stream error handling
        stream.on('error', error => {
            console.error('❌ Stream error:', error);
            serverQueue.textChannel?.send(`❌ Lỗi stream: ${error.message}`);
            serverQueue.songs.shift();
            playMusic(guild, serverQueue.songs[0]);
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

// Search YouTube - IMPROVED VERSION
async function searchYouTube(query) {
    try {
        console.log(`🔍 Tìm kiếm: ${query}`);
        
        // Kiểm tra URL YouTube
        if (ytdl.validateURL(query)) {
            console.log('📺 Lấy thông tin từ URL YouTube...');
            const info = await ytdl.getBasicInfo(query);
            
            return {
                title: info.videoDetails.title,
                url: info.videoDetails.video_url,
                duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
                thumbnail: info.videoDetails.thumbnails?.[0]?.url,
                channel: info.videoDetails.author?.name
            };
        } else {
            // Tìm kiếm bằng tên
            console.log('🔎 Tìm kiếm trên YouTube...');
            const searchResults = await ytsr(query, { limit: 10 });
            
            if (!searchResults || !searchResults.items || searchResults.items.length === 0) {
                throw new Error(`Không tìm thấy kết quả cho: "${query}"`);
            }
            
            // Lọc video
            const videos = searchResults.items.filter(item => 
                item.type === 'video' && 
                item.duration && 
                item.duration !== 'N/A' &&
                !item.isLive
            );
            
            if (videos.length === 0) {
                throw new Error('Không tìm thấy video phù hợp!');
            }
            
            const video = videos[0];
            console.log(`✅ Tìm thấy: ${video.title}`);
            
            // Validate URL trước khi return
            if (!ytdl.validateURL(video.url)) {
                throw new Error('URL video không hợp lệ!');
            }
            
            return {
                title: video.title,
                url: video.url,
                duration: video.duration,
                thumbnail: video.bestThumbnail?.url,
                channel: video.author?.name
            };
        }
    } catch (error) {
        console.error('❌ Lỗi tìm kiếm:', error);
        throw new Error(`Không thể tìm thấy bài hát: ${error.message}`);
    }
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

// Slash command interactions - FIXED VERSION
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    if (commandName === 'weather') {
        const city = interaction.options.getString('city');
        await interaction.deferReply();
        
        const weatherEmbed = await getWeather(city);
        await interaction.editReply({ embeds: [weatherEmbed] });
    }
    
    // Thay thế toàn bộ khối lệnh 'play' bằng đoạn code này
    else if (commandName === 'play') {
        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;
        
        if (!voiceChannel) {
            return interaction.reply('❌ Bạn cần vào voice channel trước!');
        }
        
        const permissions = voiceChannel.permissionsFor(interaction.client.user);
        if (!permissions.has('CONNECT') || !permissions.has('SPEAK')) {
            return interaction.reply('❌ Bot không có quyền vào voice channel!');
        }
        
        await interaction.deferReply(); // Chỉ defer một lần
        
        try {
            const song = await searchYouTube(query);
            let serverQueue = queue.get(interaction.guild.id);
            
            // Nếu không có hàng đợi, tạo mới và kết nối
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
                
                // Xử lý khi kết nối sẵn sàng
                connection.on(VoiceConnectionStatus.Ready, () => {
                    console.log('✅ Đã kết nối voice channel!');
                    playMusic(interaction.guild, serverQueue.songs[0]);
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
                if (song.thumbnail) embed.setThumbnail(song.thumbnail);
                
                await interaction.editReply({ embeds: [embed] });
            } else {
                // Nếu có hàng đợi, chỉ thêm bài hát
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
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('❌ Lỗi')
                    .setDescription(error.message)
                    .addFields({ name: '💡 Gợi ý', value: 'Hãy thử:\n• Kiểm tra link YouTube\n• Thử tìm kiếm bằng tên bài hát\n• Đảm bảo video không bị chặn' })
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