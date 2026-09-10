import { ChatOpenAI } from '@langchain/openai';
import { getConfigSection } from '../config/index.js';

export function initChatModel(): ChatOpenAI {
  // getConfigSection用于拿到配置部分
  const settings = getConfigSection(['models', 'chat_model']);
  
  if (!settings) {
    throw new Error('The `models/chat_model` section in `config.yaml` is not found');
  }
  // 从配置中获取模型名称
  const model = settings.model;
  if (!model) {
    throw new Error('The `model` in `config.yaml` is not found');
  }

  let apiKey = settings.api_key;
  if (!apiKey) {
    apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
  } else if (apiKey.startsWith('$')) {
    // 情况 2：api_key 以 $ 开头，表示引用环境变量
    const envVarName = apiKey.substring(1);
    apiKey = process.env[envVarName];
    if (!apiKey) {
      throw new Error(`Environment variable ${envVarName} is not set. Please set it or provide api_key directly in config.yaml`);
    }
  }

  if (!apiKey) {
    throw new Error('API key not found. Please set OPENAI_API_KEY or DEEPSEEK_API_KEY environment variable, or provide api_key in config.yaml');
  }

  const restSettings = { ...settings };
  delete restSettings.model;
  delete restSettings.api_key;
  delete restSettings.type;
  delete restSettings.compression_threshold;
  delete restSettings.max_tokens;

  const configuration: any = {
    modelName: model,
    apiKey,
  };

  if (settings.api_base) {
    configuration.configuration = {
      baseURL: settings.api_base,
    };
  }

  const chatModel = new ChatOpenAI({
    ...configuration,
    ...restSettings,
    maxTokens: settings.max_tokens ?? 8192,
  });

  return chatModel;
}
