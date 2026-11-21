const fs = require('fs');
const path = require('path');
const os = require('os');

class ConfigLoader {
    constructor() {
        this.config = null;
        this.configPath = path.join(__dirname, '..', 'config.json');
        this.defaultConfigPath = path.join(__dirname, '..', 'default_config.json');
        this.secretsPath = path.join(__dirname, '..', 'secrets.json');
    }

    
    loadSecrets() {
        try {
            if (!fs.existsSync(this.secretsPath)) return {};
            const s = JSON.parse(fs.readFileSync(this.secretsPath, 'utf8'));
            return (s && typeof s === 'object') ? s : {};
        } catch (e) {
            console.warn('[config] secrets.json 读取失败，按未配置处理:', e.message);
            return {};
        }
    }

    applySecrets(cfg) {
        const s = this.loadSecrets();
        if (!cfg || !Object.keys(s).length) return cfg;
        const put = (objPath, val) => {
            if (typeof val !== 'string' || !val.trim()) return;
            let cur = cfg;
            for (const k of objPath.slice(0, -1)) {
                if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
                cur = cur[k];
            }
            cur[objPath[objPath.length - 1]] = val.trim();
        };
        put(['llm', 'api_key'], s.llm_api_key);
        put(['deepseek', 'api_key'], s.deepseek_api_key);
        put(['llm', 'upstream_url'], s.llm_upstream_url);
        put(['llm', 'model'], s.llm_model);
        put(['vision', 'free', 'api_key'], s.zhipu_api_key);
        put(['memory', 'embeddings', 'api_key'], s.embedding_api_key);
        return cfg;
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const configData = fs.readFileSync(this.configPath, 'utf8');
                this.config = JSON.parse(configData);
                console.log('配置文件加载成功');
            } else {
                if (fs.existsSync(this.defaultConfigPath)) {
                    const defaultConfigData = fs.readFileSync(this.defaultConfigPath, 'utf8');
                    this.config = JSON.parse(defaultConfigData);
                    fs.writeFileSync(this.configPath, defaultConfigData, 'utf8');
                    console.log('从默认配置创建新配置文件');
                } else {
                    throw new Error('默认配置文件不存在');
                }
            }

            
            this.processSpecialPaths();

            this.applySecrets(this.config);

            return this.config;
        } catch (error) {
            console.error('加载配置文件失败:', error);
            
            return this.getDefaultConfig();
        }
    }

    
    processSpecialPaths() {
        
    }

    getDefaultConfig() {
        return {
            "llm": {
                "api_key": "YOUR_LLM_API_KEY",
                "api_url": "https://api.zhizengzeng.com/v1",
                "model": "claude-3-5-sonnet-20240620",
                "system_prompt": ""
            },
            "tts": {
                "url": "http://127.0.0.1:5000",
                "language": "zh"
            },
            "asr": {
                "vad_url": "ws://127.0.0.1:1000/v1/ws/vad",
                "asr_url": "http://127.0.0.1:1000/v1/upload_audio",
                "stream_url": "ws://127.0.0.1:1000/v1/asr_stream"
            },
            "memory": {
                "file_path": "memory/text_database.txt",
                "check_url": "http://127.0.0.1:7878/check"
            },
            "vision": {
                
                "enabled": true,
                "free": {
                    "enabled": true,
                    "model": "glm-4v-flash",
                    "fps": 1.0
                }
            },
            "ui": {
                "intro_text": "Hi, I am Neuro!",
                "model_scale": 560
            },
            "context": {
                "enable_limit": true,
                "max_messages": 8
            }
        };
    }

    save(config = null) {
        try {
            const configToSave = config || this.config;
            if (!configToSave) {
                throw new Error('没有可保存的配置');
            }

            if (fs.existsSync(this.configPath)) {
                const backupPath = `${this.configPath}.bak`;
                fs.copyFileSync(this.configPath, backupPath);
                console.log(`已创建配置文件备份: ${backupPath}`);
            }

            fs.writeFileSync(this.configPath, JSON.stringify(configToSave, null, 2), 'utf8');
            console.log('配置已保存');
            return true;
        } catch (error) {
            console.error('保存配置失败:', error);
            return false;
        }
    }
}

const configLoader = new ConfigLoader();
module.exports = { configLoader };
