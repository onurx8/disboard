const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs').promises;
const config = require('./config');

const log = {
    info: (message) => console.log(`[BILGI] ${new Date().toLocaleString()} - ${message}`),
    error: (message) => console.error(`[HATA] ${new Date().toLocaleString()} - ${message}`),
    debug: (message) => console.log(`[DEBUG] ${new Date().toLocaleString()} - ${message}`)
};

class Bot {
    constructor() {
        this.clients = [];
        this.currentClientIndex = 0;
        this.problemTokens = new Set();
        this.bumpInterval = 125 * 60 * 1000; // 125 dakika
        this.bumpCooldown = 120 * 60 * 1000; // Disboard cooldown: 120 dakika
    }

    async initialize() {
        try {
            const tokenData = await fs.readFile('tokens.txt', 'utf8');
            const tokens = tokenData.split('\n').map(t => t.trim()).filter(t => t.length > 0);

            if (tokens.length === 0) {
                throw new Error('tokens.txt dosyasında geçerli token bulunamadı.');
            }

            log.info(`${tokens.length} adet token bulundu.`);

            try {
                const problemData = await fs.readFile('problem_tokens.txt', 'utf8');
                const problemTokensList = problemData.split('\n').map(t => t.trim()).filter(t => t.length > 0);
                problemTokensList.forEach(line => {
                    const token = line.split(' - ')[0];
                    this.problemTokens.add(token);
                });
                log.info(`${this.problemTokens.size} adet sorunlu token yüklendi.`);
            } catch (error) {
                log.info('Sorunlu tokenler yüklenemedi. Yeni dosya oluşturulacak.');
            }

            this.clients = tokens.map(token => {
                const client = new Client({ checkUpdate: false });
                client.token = token;
                return client;
            });

            await this.setupClients();
        } catch (error) {
            log.error(`Başlatma hatası: ${error.message}`);
            process.exit(1);
        }
    }

    async setupClients() {
        for (const client of this.clients) {
            client.on('ready', () => {
                log.info(`${client.user.username} aktif! ID: ${client.user.id}`);
            });

            client.on('messageCreate', async (message) => {
                if (message.content === '!test' && (message.author.id === client.user.id || message.author.id === config.ownerId)) {
                    log.info(`!test komutu - Yetkili: ${message.author.id}`);
                    await this.handleTestCommand(message, client);
                }

                if (message.content === '!bump' && (message.author.id === client.user.id || message.author.id === config.ownerId)) {
                    log.info(`!bump komutu - Yetkili: ${message.author.id}`);
                    await this.checkAndSendBump(client, message.channel);
                }
            });

            client.on('error', (error) => {
                log.error(`Client hatası: ${error.message}`);
            });
        }

        await this.startBumpCycle();
    }

    async startBumpCycle() {
        log.info(`Bump döngüsü başlatılıyor. Her ${this.bumpInterval / 60000} dakikada bir bump kontrol edilecek.`);
        await this.loginNextClient();
    }

    async loginNextClient() {
        if (this.clients.length === 0) {
            log.error('Kullanılabilir client kalmadı! Program sonlandırılıyor.');
            process.exit(1);
        }

        const client = this.clients[this.currentClientIndex];
        log.info(`Sırayla giriş yapılıyor - Token sırası: ${this.currentClientIndex + 1}/${this.clients.length}`);

        if (this.problemTokens.has(client.token)) {
            log.info(`Bu token daha önce sorun yaşamıştı, atlanıyor: ${this.maskToken(client.token)}`);
            this.moveToNextClient();
            await this.loginNextClient();
            return;
        }

        try {
            await client.login(client.token);
            log.info(`${client.user.username} başarıyla giriş yaptı! Bump komutunu çalıştırmak için bekliyor...`);
            setTimeout(() => this.checkAndSendBump(client), 5000);
        } catch (error) {
            log.error(`Giriş hatası (Token ${this.currentClientIndex + 1}): ${error.message}`);
            await this.recordProblemToken(client.token, `Giriş hatası: ${error.message}`);
            await client.destroy().catch(() => log.error('Client kapatılamadı, devam ediliyor...'));
            this.moveToNextClient();
            await this.loginNextClient();
        }
    }

    async checkAndSendBump(client, responseChannel = null) {
        try {
            const channel = client.channels.cache.get(config.channelId);
            if (!channel) {
                log.error(`Kanal bulunamadı: ${config.channelId}`);
                throw new Error('Kanal bulunamadı');
            }

            // Her token için kalan süreyi kontrol et
            const messages = await channel.messages.fetch({ limit: 100 });
            let lastBumpMessage = null;

            for (const message of messages.values()) {
                if (message.author.id === config.disboardBotId) {
                    const embed = message.embeds[0];
                    if (embed) {
                        log.debug(`Disboard mesajı bulundu: ${JSON.stringify(embed)}`);
                        if (embed.description?.includes('Öne çıkarma başarılı!')) {
                            lastBumpMessage = message;
                            break;
                        }
                    }
                }
            }

            let remainingTime = 0;
            if (lastBumpMessage) {
                const lastBumpTime = lastBumpMessage.createdTimestamp;
                const timeSinceLastBump = Date.now() - lastBumpTime;
                remainingTime = this.bumpCooldown - timeSinceLastBump;

                if (timeSinceLastBump < this.bumpCooldown) {
                    log.info(`${client.user.username} için bump henüz mümkün değil. Son bump: ${new Date(lastBumpTime).toLocaleString()}, Kalan süre: ${Math.ceil(remainingTime / 60000)} dakika. Bekleniyor...`);
                    if (responseChannel) {
                        await responseChannel.send(`Bump için henüz süre dolmamış. Kalan süre: ${Math.ceil(remainingTime / 60000)} dakika.`);
                    }
                    setTimeout(() => this.checkAndSendBump(client, responseChannel), remainingTime + 1000);
                    return;
                }
            } else {
                log.info('Son başarılı bump mesajı bulunamadı, bump denenecek.');
            }

            // Bump dene
            log.info(`${client.user.username} için /bump komutu deneniyor...`);
            await channel.sendSlash(config.disboardBotId, 'bump');

            // Disboard’un başarılı bump mesajını bekle
            const disboardResponse = await channel.awaitMessages({
                filter: m => m.author.id === config.disboardBotId && m.embeds.length > 0 && 
                    m.embeds[0].description?.includes('Öne çıkarma başarılı!'),
                max: 1,
                time: 15000,
                errors: ['time']
            }).catch(() => null);

            if (disboardResponse && disboardResponse.size > 0) {
                log.info(`${client.user.username} başarıyla /bump komutunu gönderdi!`);
                if (responseChannel) {
                    await responseChannel.send('Bump başarılı! Sunucu öne çıkarıldı.');
                }
                await this.switchToNextClient(client);
            } else {
                // Bump başarısız, bir sonraki hesaba geç
                log.info(`${client.user.username} bump atamadı, bir sonraki hesaba geçiliyor...`);
                if (responseChannel) {
                    await responseChannel.send('Bu hesap bump atamadı, bir sonraki hesaba geçiliyor.');
                }
                await this.switchToNextClient(client);
            }
        } catch (error) {
            log.error(`Bump kontrol hatası (${client.user?.username || 'Bilinmiyor'}): ${error.message}`);
            if (error.code === 50013) {
                log.info(`İzin eksikliği - Kullanıcı: ${client.user?.username || 'Bilinmiyor'}`);
                await this.recordProblemToken(client.token, 'İzin eksikliği (50013)');
                if (responseChannel) {
                    await responseChannel.send('Hata: Bu hesapta /bump komutunu çalıştırma izni yok.');
                }
            }
            // Hata durumunda bir sonraki hesaba geç
            log.info(`${client.user?.username || 'Bilinmeyen'} bump atamadı, bir sonraki hesaba geçiliyor...`);
            if (responseChannel) {
                await responseChannel.send('Bu hesap bump atamadı, bir sonraki hesaba geçiliyor.');
            }
            await this.switchToNextClient(client);
        }
    }

    async switchToNextClient(client) {
        try {
            await client.destroy();
            log.info(`${client.user.username} güvenli şekilde kapatıldı.`);
        } catch (err) {
            log.error(`Client kapatılırken hata: ${err.message}`);
        }

        this.moveToNextClient();
        log.info(`Bir sonraki bump için ${this.bumpInterval / 60000} dakika bekleniyor...`);
        setTimeout(() => this.loginNextClient(), this.bumpInterval);
    }

    async handleTestCommand(message, client) {
        await this.checkAndSendBump(client, message.channel);
    }

    moveToNextClient() {
        this.currentClientIndex = (this.currentClientIndex + 1) % this.clients.length;
        log.info(`Sırayla bir sonraki token’a geçildi - Yeni sıra: ${this.currentClientIndex + 1}/${this.clients.length}`);
    }

    maskToken(token) {
        if (!token) return 'Bilinmeyen Token';
        return token.substring(0, 6) + '...' + token.substring(token.length - 6);
    }

    async recordProblemToken(token, reason) {
        if (!token) return;

        try {
            const maskedToken = this.maskToken(token);
            this.problemTokens.add(token);
            await fs.appendFile('problem_tokens.txt', `${maskedToken} - ${reason}\n`);
            log.info(`Sorunlu token kaydedildi: ${maskedToken}`);
        } catch (error) {
            log.error(`Problem token kaydedilirken hata: ${error.message}`);
        }
    }

    async start() {
        await this.initialize();
    }
}

module.exports = Bot;