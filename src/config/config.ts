import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

let config: Record<string, any> | null = null;

export function loadConfig(): Record<string, any> {
  if (config === null) {
    // 加载config.yaml文件中的配置
    const configPath = path.join(process.cwd(), 'config.yaml');
    if (!fs.existsSync(configPath)) {
      throw new Error("dl-code's `config.yaml` file is not found");
    }
    const fileContents = fs.readFileSync(configPath, 'utf8');
    config = yaml.parse(fileContents);
  }
  return config as Record<string, any>;
}

export function getConfigSection(key: string | string[]): any {
  const pathArray = Array.isArray(key) ? key : [key];
  const globalConfig = loadConfig();
  let section: any = globalConfig;
  
  for (const k of pathArray) {
    if (section === null || section === undefined || !(k in section)) {
      return null;
    }
    section = section[k];
  }
  
  return section;
}
