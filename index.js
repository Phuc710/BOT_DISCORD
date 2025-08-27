const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
// Tạm bỏ voice cho Windows, sẽ thêm sau khi fix dependencies
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const axios = require('axios');
require('dotenv').config();

// Config từ .env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const WELCOME_CHANNEL_ID = '💬𝓒𝓱𝓪𝓽'; // ID của channel welcome
const AUTO_ROLE_NAME = '🦄 AKKA LOO';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
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
            option.setName('url')
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
        .setDescription('Xem danh sách phát')
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
        console.log('Đã đăng ký thành công slash commands!');
    } catch (error) {
        console.error('Lỗi khi đăng ký commands:', error);
    }
}

// Weather function
async function getWeather(city) {
    try {
        // Chuyển đổi tên thành phố tiếng Việt
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
async function play(guild, song) {
    const serverQueue = queue.get(guild.id);
    
    if (!song) {
        serverQueue.voiceChannel.leave();
        queue.delete(guild.id);
        return;
    }
    
    try {
        const stream = ytdl(song.url, { 
            filter: 'audioonly',
            highWaterMark: 1 << 25,
            quality: 'highestaudio'
        });
        
        const resource = createAudioResource(stream);
        const player = createAudioPlayer();
        
        player.play(resource);
        serverQueue.connection.subscribe(player);
        
        player.on(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            play(guild, serverQueue.songs[0]);
        });
        
        player.on('error', error => {
            console.error('Player error:', error);
            serverQueue.textChannel.send('❌ Có lỗi khi phát nhạc!');
        });
        
        serverQueue.textChannel.send({
            embeds: [new EmbedBuilder()
                .setTitle('🎵 Đang phát')
                .setDescription(`**${song.title}**`)
                .setColor('#00ff00')]
        });
        
    } catch (error) {
        console.error('Play error:', error);
        serverQueue.textChannel.send('❌ Không thể phát bài này!');
        serverQueue.songs.shift();
        play(guild, serverQueue.songs[0]);
    }
}

// Bot events
client.once('clientReady', () => {
    console.log(`✅ Bot đã online: ${client.user.tag}`);
    // Set bot status
    client.user.setActivity('🎵 Nhạc & Thời tiết', { type: 'LISTENING' });
});

// Auto role when member joins
client.on('guildMemberAdd', async (member) => {
    try {
        // Tìm role theo tên
        const role = member.guild.roles.cache.find(r => r.name === AUTO_ROLE_NAME);
        if (role) {
            await member.roles.add(role);
            console.log(`✅ Đã thêm role "${AUTO_ROLE_NAME}" cho ${member.user.tag}`);
        }
        
        // Gửi tin nhắn chào mừng
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
        const url = interaction.options.getString('url');
        const voiceChannel = interaction.member.voice.channel;
        
        if (!voiceChannel) {
            return interaction.reply('❌ Bạn cần vào voice channel trước!');
        }
        
        await interaction.deferReply();
        
        try {
            let songUrl = url;
            
            // Kiểm tra nếu không phải YouTube URL thì search
            if (!ytdl.validateURL(url)) {
                await interaction.editReply('❌ Vui lòng cung cấp link YouTube hợp lệ!');
                return;
            }
            
            const songInfo = await ytdl.getInfo(songUrl);
            const song = {
                title: songInfo.videoDetails.title,
                url: songInfo.videoDetails.video_url,
            };
            
            const serverQueue = queue.get(interaction.guild.id);
            
            if (!serverQueue) {
                const queueContruct = {
                    textChannel: interaction.channel,
                    voiceChannel: voiceChannel,
                    connection: null,
                    songs: [],
                    volume: 5,
                    playing: true,
                };
                
                queue.set(interaction.guild.id, queueContruct);
                queueContruct.songs.push(song);
                
                try {
                    const connection = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: interaction.guild.id,
                        adapterCreator: interaction.guild.voiceAdapterCreator,
                    });
                    
                    queueContruct.connection = connection;
                    play(interaction.guild, queueContruct.songs[0]);
                    
                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setTitle('✅ Đã thêm vào hàng đợi')
                            .setDescription(`**${song.title}**`)
                            .setColor('#00ff00')]
                    });
                    
                } catch (err) {
                    console.log(err);
                    queue.delete(interaction.guild.id);
                    await interaction.editReply('❌ Không thể kết nối voice channel!');
                }
            } else {
                serverQueue.songs.push(song);
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('✅ Đã thêm vào hàng đợi')
                        .setDescription(`**${song.title}**`)
                        .setColor('#00ff00')]
                });
            }
            
        } catch (error) {
            console.error('Play command error:', error);
            await interaction.editReply('❌ Có lỗi xảy ra khi xử lý bài hát!');
        }
    }
    
    else if (commandName === 'stop') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue) {
            return interaction.reply('❌ Không có nhạc nào đang phát!');
        }
        
        serverQueue.songs = [];
        serverQueue.connection.destroy();
        queue.delete(interaction.guild.id);
        
        await interaction.reply('⏹️ Đã dừng nhạc và rời voice channel!');
    }
    
    else if (commandName === 'skip') {
        const serverQueue = queue.get(interaction.guild.id);
        
        if (!serverQueue) {
            return interaction.reply('❌ Không có nhạc nào đang phát!');
        }
        
        serverQueue.songs.shift();
        play(interaction.guild, serverQueue.songs[0]);
        
        await interaction.reply('⏭️ Đã bỏ qua bài hiện tại!');
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
            return `${index === 0 ? '🎵' : `${index + 1}.`} ${song.title}`;
        }).join('\n');
        
        embed.setDescription(queueList || 'Trống');
        
        if (serverQueue.songs.length > 10) {
            embed.setFooter({ text: `Và ${serverQueue.songs.length - 10} bài khác...` });
        }
        
        await interaction.reply({ embeds: [embed] });
    }
});

// Error handling & Auto-restart
client.on('error', (error) => {
    console.error('Client error:', error);
});

client.on('disconnect', () => {
    console.log('Bot disconnected, attempting reconnect...');
});

client.on('reconnecting', () => {
    console.log('Bot reconnecting...');
});

// Keep alive function cho hosting free
function keepAlive() {
    setInterval(() => {
        console.log('Bot is alive! ' + new Date().toLocaleString('vi-VN'));
    }, 5 * 60 * 1000); // 5 phút
}

// Anti-crash
process.on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.log('Uncaught Exception:', err);
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