import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// GPU VRAM & Performance Monitoring Helpers
const psScript = `$counters = Get-Counter -Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue
if ($counters) {
    $results = @()
    foreach ($s in $counters.CounterSamples) {
        if ($s.CookedValue -gt 1MB) {
            $start = $s.Path.IndexOf("(")
            $end = $s.Path.IndexOf(")")
            if ($start -ge 0 -and $end -gt $start) {
                $instance = $s.Path.Substring($start + 1, $end - $start - 1)
                if ($instance -like "pid_*") {
                    $parts = $instance.Split("_")
                    if ($parts.Count -gt 1) {
                        $targetPid = $parts[1]
                        $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
                        if ($proc -and ($proc.Name -like "*RimWorld*" -or $proc.Name -like "*LM Studio*" -or $proc.Name -like "*llama*")) {
                            $exists = $false
                            foreach ($r in $results) {
                                if ($r.Pid -eq $targetPid) { $exists = $true; break }
                            }
                            if (-not $exists) {
                                $results += [PSCustomObject]@{
                                    Pid = $targetPid
                                    Name = $proc.Name
                                    VramMB = [math]::round($s.CookedValue / 1MB, 2)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    $results | ConvertTo-Json -Compress
} else {
    Write-Host "[]"
}`;

const writePsScript = () => {
  try {
    fs.writeFileSync(path.join(__dirname, 'query_gpu.ps1'), psScript, 'utf8');
  } catch (e) {
    console.error('Failed to write query_gpu.ps1:', e.message);
  }
};

const fetchGPUStats = () => {
  return new Promise((resolve) => {
    const stats = {
      supported: false,
      utilization: 0,
      usedVram: 0,
      totalVram: 0,
      processes: []
    };
    
    exec('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits', (err, stdout) => {
      if (err) {
        return resolve(stats);
      }
      
      const parts = stdout.trim().split(',');
      if (parts.length >= 3) {
        stats.supported = true;
        stats.utilization = parseInt(parts[0].trim()) || 0;
        stats.usedVram = (parseInt(parts[1].trim()) || 0) / 1024;
        stats.totalVram = (parseInt(parts[2].trim()) || 0) / 1024;
      }
      
      const scriptPath = path.join(__dirname, 'query_gpu.ps1');
      exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (psErr, psStdout) => {
        if (!psErr && psStdout.trim()) {
          try {
            let jsonStr = psStdout.trim();
            const startIdx = jsonStr.indexOf('[');
            if (startIdx !== -1) {
              jsonStr = jsonStr.substring(startIdx);
              const list = JSON.parse(jsonStr);
              stats.processes = Array.isArray(list) ? list : [list];
            }
          } catch (e) {
            // parsing failed
          }
        }
        resolve(stats);
      });
    });
  });
};

// Global Metrics & Capacity Tracking Variables
const recentRequestsMetrics = [];
const activePawnsTracker = new Map();

const pruneActivePawns = () => {
  const now = Date.now();
  const tenMinutesAgo = now - 600000;
  for (const [name, ts] of activePawnsTracker.entries()) {
    if (ts < tenMinutesAgo) {
      activePawnsTracker.delete(name);
    }
  }
};

// Initialize Configuration
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  port: 3000,
  lmStudioUrl: 'http://127.0.0.1:1234',
  bridgeApiKey: 'rimsynapse-bridge',   // key RimSynapse sends; set in RimWorld mod settings
  lmStudioApiKey: '',               // optional; only needed if LM Studio has auth enabled
  autoMapModel: true,
  sanitizeResponse: true,
  timeoutMs: 120000, // 2 minutes
  queueConcurrency: 1
};

// Load existing config if available
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = { ...config, ...JSON.parse(data) };
  } catch (err) {
    console.error('Error reading config file, using defaults:', err);
  }
}

// Save configuration helper
const saveConfig = () => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving config file:', err);
    return false;
  }
};

const app = express();
app.use(cors());

// Route rewriter to handle clients that append /v1 to an endpoint that already has it,
// resulting in /v1/v1/chat/completions.
app.use((req, res, next) => {
  if (req.url.startsWith('/v1/v1/')) {
    const originalUrl = req.url;
    req.url = req.url.replace(/^\/v1/, '');
    logToDashboard('info', 'proxy', `Rewrote double-prefixed request: ${originalUrl} -> ${req.url}`);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware for /v1/* routes — validates Bearer token from RimSynapse
const validateBridgeAuth = (req, res, next) => {
  // If no bridgeApiKey is configured, skip auth
  if (!config.bridgeApiKey) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    logToDashboard('warn', 'proxy', `Rejected unauthenticated ${req.method} ${req.path}`);
    return res.status(401).json({ error: { message: 'Missing Authorization header. Set your API key in RimSynapse settings.', type: 'auth_error', code: 'missing_key' } });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== config.bridgeApiKey) {
    logToDashboard('warn', 'proxy', `Rejected invalid API key on ${req.method} ${req.path}`);
    return res.status(401).json({ error: { message: 'Invalid API key.', type: 'auth_error', code: 'invalid_key' } });
  }

  next();
};

// Apply auth to all OpenAI-compatible proxy routes
app.use('/v1', validateBridgeAuth);

// In-Memory Request Queue and Logger
const logBuffer = [];
const activeRequests = new Map();
const queue = [];
let processingQueue = false;

// SSE Client Connections
let sseClients = [];

// Log helper
const logToDashboard = (level, type, message, details = null) => {
  const logEntry = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toISOString(),
    level, // 'info', 'warn', 'error', 'success'
    type,  // 'server', 'proxy', 'queue', 'lm-studio'
    message,
    details
  };
  
  logBuffer.push(logEntry);
  if (logBuffer.length > 100) logBuffer.shift();
  
  // Track prompt/completion tokens for capacity metrics
  if (type === 'proxy' && level === 'success' && details) {
    if (details.promptTokens !== undefined && details.completionTokens !== undefined) {
      recentRequestsMetrics.push({
        timestamp: Date.now(),
        promptTokens: details.promptTokens,
        completionTokens: details.completionTokens,
        durationMs: details.durationMs || 0
      });
      if (recentRequestsMetrics.length > 50) {
        recentRequestsMetrics.shift();
      }
    }
  }
  
  // Stream to all connected SSE clients
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });
  
  console.log(`[${logEntry.timestamp}] [${level.toUpperCase()}] [${type}] ${message}`);
};

// Queue class / worker
const processQueue = async () => {
  if (processingQueue || queue.length === 0) return;
  processingQueue = true;
  
  logToDashboard('info', 'queue', `Starting queue processing. Queue length: ${queue.length}`);
  
  while (queue.length > 0) {
    const task = queue.shift();
    logToDashboard('info', 'queue', `Processing request in queue. Remaining: ${queue.length}`);
    
    try {
      await task();
    } catch (err) {
      logToDashboard('error', 'queue', `Error during task execution: ${err.message}`);
    }
  }
  
  processingQueue = false;
  logToDashboard('info', 'queue', 'Queue is now empty.');
};

// Helper: Clean Markdown wrappers, strip think blocks, repair JSON, and wrap plain text fallbacks
const sanitizeMessageContent = (content, isPawnDialogue = false) => {
  if (!content || typeof content !== 'string') return content;
  
  let cleaned = content.trim();
  
  // 1. Remove <think>...</think> blocks if present (case-insensitive, multi-line)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  
  // 2. Regex to match ```json <content> ``` or just ``` <content> ```
  const mdJsonRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = cleaned.match(mdJsonRegex);
  
  if (match && match[1]) {
    logToDashboard('success', 'proxy', 'Successfully cleaned markdown code blocks from LLM output.');
    cleaned = match[1].trim();
  }
  
  // 3. Double-check think blocks again (just in case they were inside the markdown blocks)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  
  // 4. Robust JSON check & repair for Pawn Dialogues and Statements
  const looksLikeJson = cleaned.startsWith('{') || cleaned.includes('"reply"') || cleaned.includes('"thought"');
  if (isPawnDialogue || looksLikeJson) {
    let parsed = null;
    let jsonStr = cleaned;
    
    // Find the first '{' and last '}' to extract a potential JSON object from surrounding text
    const startIdx = jsonStr.indexOf('{');
    const endIdx = jsonStr.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonStr = jsonStr.substring(startIdx, endIdx + 1);
    }
    
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // Attempt simple regex repairs for common JSON formatting issues
      try {
        const repaired = jsonStr
          .replace(/,\s*}/g, '}')  // remove trailing comma before closing brace
          .replace(/,\s*\]/g, ']'); // remove trailing comma before closing bracket
        parsed = JSON.parse(repaired);
      } catch (err) {
        // Repair failed, parsed remains null
      }
    }
    
    if (parsed) {
      // Normalize pawn dialogue keys if it's supposed to be dialogue
      if (parsed.hasOwnProperty('reply') || parsed.hasOwnProperty('thought') || isPawnDialogue) {
        if (!parsed.hasOwnProperty('reply')) {
          parsed.reply = '';
        }
        if (!parsed.hasOwnProperty('thought') || typeof parsed.thought !== 'object' || parsed.thought === null) {
          parsed.thought = {
            tag: 'NEUTRAL',
            description: 'Responded',
            relation_delta: 0
          };
        } else {
          const thought = parsed.thought;
          if (!thought.hasOwnProperty('tag')) {
            thought.tag = 'NEUTRAL';
          }
          if (!thought.hasOwnProperty('description')) {
            thought.description = 'Responded';
          }
          if (!thought.hasOwnProperty('relation_delta')) {
            thought.relation_delta = 0;
          } else {
            const val = parseInt(thought.relation_delta);
            thought.relation_delta = isNaN(val) ? 0 : val;
          }
        }
        
        // Populate root-level compat fields
        parsed.relation_delta = parsed.thought.relation_delta;
        
        return JSON.stringify(parsed);
      }
    } else if (isPawnDialogue) {
      // Fallback: If it's a pawn dialogue request but we couldn't parse/extract any valid JSON,
      // wrap the raw text in the exact JSON schema the mod expects.
      try {
        const wrapped = {
          reply: cleaned,
          thought: {
            tag: 'NEUTRAL',
            description: 'Responded',
            relation_delta: 0
          },
          relation_delta: 0
        };
        logToDashboard('warn', 'proxy', 'Wrapped plain-text response into valid JSON dialogue format.');
        return JSON.stringify(wrapped);
      } catch (err) {
        // Fallback fallback: return original cleaned text
      }
    }
  }
  
  return cleaned;
};

// Helper: Check connectivity to LM Studio and fetch loaded models
// Sends auth only if lmStudioApiKey is configured (for setups with auth enabled)
const fetchLMStudioModels = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const headers = {};
    if (config.lmStudioApiKey) {
      headers['Authorization'] = `Bearer ${config.lmStudioApiKey}`;
    }
    
    const response = await fetch(`${config.lmStudioUrl}/v1/models`, {
      signal: controller.signal,
      headers
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    
    const data = await response.json();
    return { online: true, models: data.data || [] };
  } catch (err) {
    return { online: false, error: err.message, models: [] };
  }
};

// Helper: Fetch detailed information about the loaded model context size from native LM Studio API
const fetchLMStudioActiveContext = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const headers = {};
    if (config.lmStudioApiKey) {
      headers['Authorization'] = `Bearer ${config.lmStudioApiKey}`;
    }
    
    const response = await fetch(`${config.lmStudioUrl}/api/v1/models`, {
      signal: controller.signal,
      headers
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.models) return null;
    
    // Find the first active loaded model that is of type LLM and has an active context_length
    for (const m of data.models) {
      if (m.type === 'llm' && m.loaded_instances && m.loaded_instances.length > 0) {
        const instance = m.loaded_instances[0];
        if (instance.config && instance.config.context_length) {
          return {
            modelId: instance.id,
            contextLength: instance.config.context_length
          };
        }
      }
    }
    return null;
  } catch (err) {
    return null;
  }
};



// Helper: Get RimWorld local config directory
const getRimWorldConfigPath = () => {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (!userProfile) return null;
  return path.join(userProfile, 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config');
};

// Helper: Find Mod XML config file in local appdata folder
const findRimMindConfigFile = () => {
  const configDir = getRimWorldConfigPath();
  if (!configDir || !fs.existsSync(configDir)) return null;
  
  try {
    const files = fs.readdirSync(configDir);
    const rimMindFile = files.find(f => f.startsWith('Mod_') && (f.endsWith('_RimMindCoreMod.xml') || f.endsWith('_RimSynapseCoreMod.xml') || f.toLowerCase().includes('rimsynapse')));
    return rimMindFile ? path.join(configDir, rimMindFile) : null;
  } catch (err) {
    console.error('Error scanning RimWorld config directory:', err);
    return null;
  }
};

// Helper: Read settings from local RimMind/RimChat configuration XML
const readRimMindConfig = (customFilePath = null) => {
  const filePath = customFilePath || findRimMindConfigFile();
  const defaultDir = getRimWorldConfigPath() || '';
  const defaultFile = defaultDir ? path.join(defaultDir, 'Mod_3707741395_RimMindCoreMod.xml') : '';
  
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      found: false,
      searchPath: defaultDir,
      filePath: filePath || defaultFile,
      fileName: filePath ? path.basename(filePath) : 'Mod_3707741395_RimMindCoreMod.xml',
      apiKey: '',
      apiEndpoint: '',
      modelName: ''
    };
  }
  
  try {
    const xml = fs.readFileSync(filePath, 'utf8');
    const isRimChat = path.basename(filePath).toLowerCase().includes('rimchat');
    
    let apiKey = '';
    let apiEndpoint = '';
    let modelName = '';
    
    if (isRimChat) {
      // Extract from LocalConfig or CloudConfigs
      const baseUrlMatch = xml.match(/<LocalConfig>[\s\S]*?<baseUrl>([\s\S]*?)<\/baseUrl>/);
      const modelNameMatch = xml.match(/<LocalConfig>[\s\S]*?<modelName>([\s\S]*?)<\/modelName>/);
      
      apiEndpoint = baseUrlMatch ? baseUrlMatch[1].trim() : '';
      modelName = modelNameMatch ? modelNameMatch[1].trim() : '';
      
      // Try to find apiKey in CloudConfigs Custom provider
      const customApiKeyMatch = xml.match(/<provider>Custom<\/provider>[\s\S]*?<apiKey>([\s\S]*?)<\/apiKey>/);
      apiKey = customApiKeyMatch ? customApiKeyMatch[1].trim() : '';
      
      if (!apiEndpoint) {
        const customUrlMatch = xml.match(/<provider>Custom<\/provider>[\s\S]*?<baseUrl>([\s\S]*?)<\/baseUrl>/);
        apiEndpoint = customUrlMatch ? customUrlMatch[1].trim() : '';
      }
      if (!modelName) {
        const customModelMatch = xml.match(/<provider>Custom<\/provider>[\s\S]*?<customModelName>([\s\S]*?)<\/customModelName>/);
        modelName = customModelMatch ? customModelMatch[1].trim() : '';
      }
    } else {
      // RimMind format
      const apiKeyMatch = xml.match(/<apiKey>([\s\S]*?)<\/apiKey>/);
      const apiEndpointMatch = xml.match(/<apiEndpoint>([\s\S]*?)<\/apiEndpoint>/);
      const modelNameMatch = xml.match(/<modelName>([\s\S]*?)<\/modelName>/);
      
      apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : '';
      apiEndpoint = apiEndpointMatch ? apiEndpointMatch[1].trim() : '';
      modelName = modelNameMatch ? modelNameMatch[1].trim() : '';
    }
    
    return {
      found: true,
      filePath,
      fileName: path.basename(filePath),
      apiKey,
      apiEndpoint,
      modelName
    };
  } catch (err) {
    return { 
      found: false, 
      searchPath: defaultDir, 
      filePath: filePath || defaultFile,
      fileName: filePath ? path.basename(filePath) : 'Mod_3707741395_RimMindCoreMod.xml',
      error: err.message 
    };
  }
};

// Helper: Update settings in local RimMind/RimChat configuration XML
const updateRimMindConfig = (endpoint, apiKey, modelName, customFilePath = null) => {
  const filePath = customFilePath || findRimMindConfigFile();
  const defaultDir = getRimWorldConfigPath() || '';
  const targetPath = filePath || (defaultDir ? path.join(defaultDir, 'Mod_3707741395_RimMindCoreMod.xml') : null);
  
  if (!targetPath) {
    return { success: false, message: 'RimWorld config directory could not be resolved.' };
  }
  
  const isRimChat = path.basename(targetPath).toLowerCase().includes('rimchat');
  
  // If file doesn't exist, create it with template settings
  if (!fs.existsSync(targetPath)) {
    try {
      const folder = path.dirname(targetPath);
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
      
      let defaultXml = '';
      if (isRimChat) {
        defaultXml = `<?xml version="1.0" encoding="utf-8"?>
<SettingsBlock>
\t<ModSettings Class="RimChat.RimChatSettings">
\t\t<CloudConfigs>
\t\t\t<li>
\t\t\t\t<provider>Custom</provider>
\t\t\t\t<apiKey>${apiKey}</apiKey>
\t\t\t\t<selectedModel>Custom</selectedModel>
\t\t\t\t<customModelName>${modelName}</customModelName>
\t\t\t\t<baseUrl>${endpoint.replace(/\/+$/, '')}</baseUrl>
\t\t\t</li>
\t\t</CloudConfigs>
\t\t<LocalConfig>
\t\t\t<baseUrl>${endpoint}</baseUrl>
\t\t\t<modelName>${modelName}</modelName>
\t\t</LocalConfig>
\t</ModSettings>
</SettingsBlock>`;
      } else {
        const isRimSynapse = path.basename(targetPath).toLowerCase().includes('rimsynapse');
        const settingsClass = isRimSynapse ? 'RimSynapse.RimSynapseCoreSettings' : 'RimMind.RimMindCoreSettings';
        defaultXml = `<?xml version="1.0" encoding="utf-8"?>
<ModSettings Class="${settingsClass}">
\t<apiEndpoint>${endpoint}</apiEndpoint>
\t<apiKey>${apiKey}</apiKey>
\t<modelName>${modelName}</modelName>
</ModSettings>`;
      }
      fs.writeFileSync(targetPath, defaultXml, 'utf8');
      return { success: true };
    } catch (e) {
      return { success: false, message: `Could not create settings file: ${e.message}` };
    }
  }
  
  try {
    let xml = fs.readFileSync(targetPath, 'utf8');
    
    if (isRimChat) {
      // 1. Update LocalConfig
      if (xml.includes('<LocalConfig />')) {
        xml = xml.replace('<LocalConfig />', `<LocalConfig>\n\t\t\t<baseUrl>${endpoint}</baseUrl>\n\t\t\t<modelName>${modelName}</modelName>\n\t\t</LocalConfig>`);
      } else if (xml.includes('<LocalConfig>')) {
        // replace baseUrl
        if (xml.match(/<LocalConfig>[\s\S]*?<baseUrl>[\s\S]*?<\/baseUrl>/)) {
          xml = xml.replace(/(<LocalConfig>[\s\S]*?<baseUrl>)([\s\S]*?)(<\/baseUrl>)/, `$1${endpoint}$3`);
        } else {
          xml = xml.replace('<LocalConfig>', `<LocalConfig>\n\t\t\t<baseUrl>${endpoint}</baseUrl>`);
        }
        // replace modelName
        if (xml.match(/<LocalConfig>[\s\S]*?<modelName>[\s\S]*?<\/modelName>/)) {
          xml = xml.replace(/(<LocalConfig>[\s\S]*?<modelName>)([\s\S]*?)(<\/modelName>)/, `$1${modelName}$3`);
        } else {
          xml = xml.replace('</LocalConfig>', `\t\t\t<modelName>${modelName}</modelName>\n\t\t</LocalConfig>`);
        }
      } else {
        xml = xml.replace('</ModSettings>', `\t<LocalConfig>\n\t\t\t<baseUrl>${endpoint}</baseUrl>\n\t\t\t<modelName>${modelName}</modelName>\n\t\t</LocalConfig>\n\t</ModSettings>`);
      }
      
      // 2. Update CloudConfigs
      const cleanEndpoint = endpoint.replace(/\/+$/, '');
      if (xml.includes('<CloudConfigs />')) {
        xml = xml.replace('<CloudConfigs />', `<CloudConfigs>\n\t\t\t<li>\n\t\t\t\t<provider>Custom</provider>\n\t\t\t\t<apiKey>${apiKey}</apiKey>\n\t\t\t\t<selectedModel>Custom</selectedModel>\n\t\t\t\t<customModelName>${modelName}</customModelName>\n\t\t\t\t<baseUrl>${cleanEndpoint}</baseUrl>\n\t\t\t</li>\n\t\t</CloudConfigs>`);
      } else if (xml.includes('<CloudConfigs>')) {
        if (xml.includes('<provider>Custom</provider>')) {
          // Replace matching Custom block properties
          const customBlockRegex = /(<li>\s*<provider>Custom<\/provider>[\s\S]*?<\/li>)/;
          const newBlock = `<li>\n\t\t\t\t<provider>Custom</provider>\n\t\t\t\t<apiKey>${apiKey}</apiKey>\n\t\t\t\t<selectedModel>Custom</selectedModel>\n\t\t\t\t<customModelName>${modelName}</customModelName>\n\t\t\t\t<baseUrl>${cleanEndpoint}</baseUrl>\n\t\t\t</li>`;
          xml = xml.replace(customBlockRegex, newBlock);
        } else {
          const entry = `\t\t\t<li>\n\t\t\t\t<provider>Custom</provider>\n\t\t\t\t<apiKey>${apiKey}</apiKey>\n\t\t\t\t<selectedModel>Custom</selectedModel>\n\t\t\t\t<customModelName>${modelName}</customModelName>\n\t\t\t\t<baseUrl>${cleanEndpoint}</baseUrl>\n\t\t\t</li>\n`;
          xml = xml.replace('<CloudConfigs>', `<CloudConfigs>\n${entry}`);
        }
      } else {
        xml = xml.replace('</ModSettings>', `\t<CloudConfigs>\n\t\t\t<li>\n\t\t\t\t<provider>Custom</provider>\n\t\t\t\t<apiKey>${apiKey}</apiKey>\n\t\t\t\t<selectedModel>Custom</selectedModel>\n\t\t\t\t<customModelName>${modelName}</customModelName>\n\t\t\t\t<baseUrl>${cleanEndpoint}</baseUrl>\n\t\t\t</li>\n\t\t</CloudConfigs>\n\t</ModSettings>`);
      }
    } else {
      // Replace or insert apiKey element
      if (xml.includes('<apiKey>')) {
        xml = xml.replace(/<apiKey>([\s\S]*?)<\/apiKey>/, `<apiKey>${apiKey}</apiKey>`);
      } else {
        xml = xml.replace('</ModSettings>', `\t<apiKey>${apiKey}</apiKey>\n\t</ModSettings>`);
      }
      
      // Replace or insert apiEndpoint element
      if (xml.includes('<apiEndpoint>')) {
        xml = xml.replace(/<apiEndpoint>([\s\S]*?)<\/apiEndpoint>/, `<apiEndpoint>${endpoint}</apiEndpoint>`);
      } else {
        xml = xml.replace('</ModSettings>', `\t<apiEndpoint>${endpoint}</apiEndpoint>\n\t</ModSettings>`);
      }
      
      // Replace or insert modelName element
      if (modelName) {
        if (xml.includes('<modelName>')) {
          xml = xml.replace(/<modelName>([\s\S]*?)<\/modelName>/, `<modelName>${modelName}</modelName>`);
        } else {
          xml = xml.replace('</ModSettings>', `\t<modelName>${modelName}</modelName>\n\t</ModSettings>`);
        }
      }
    }
    
    fs.writeFileSync(targetPath, xml, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

// Helper: Find RimChat Prompt Presets File
const findRimChatPromptPresetsFile = () => {
  const configDir = getRimWorldConfigPath();
  if (!configDir) return null;
  return path.join(configDir, 'RimChat', 'Prompt', 'Custom', 'PromptPresets_Custom.json');
};

// Helper: Read context settings from RimChat Prompt Presets JSON
const readRimChatContext = () => {
  const filePath = findRimChatPromptPresetsFile();
  if (!filePath || !fs.existsSync(filePath)) {
    return { found: false, searchPath: path.join(getRimWorldConfigPath() || '', 'RimChat') };
  }
  
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(data);
    
    // Find active preset or default to first preset
    const activePreset = json.Presets.find(p => p.Id === json.ActivePresetId) || json.Presets[0];
    if (!activePreset) {
      return { found: true, noPresets: true, filePath };
    }
    
    const payloads = activePreset.ChannelPayloads || {};
    const diplomacy = payloads.Diplomacy || {};
    
    let diplomacyConfig = {};
    if (diplomacy.SystemPromptCustomJson) {
      try {
        diplomacyConfig = JSON.parse(diplomacy.SystemPromptCustomJson);
      } catch (e) {}
    }
    
    return {
      found: true,
      filePath,
      fileName: path.basename(filePath),
      presetName: activePreset.Name,
      maxSceneChars: diplomacyConfig.EnvironmentPrompt?.SceneSystem?.MaxSceneChars || 1200,
      maxTotalChars: diplomacyConfig.EnvironmentPrompt?.SceneSystem?.MaxTotalChars || 4000,
      maxInjectedChars: diplomacyConfig.EnvironmentPrompt?.EventIntelPrompt?.MaxInjectedChars || 1200,
      summaryCharBudget: diplomacyConfig.PromptPolicy?.SummaryCharBudget || 1200
    };
  } catch (err) {
    return { found: false, error: err.message };
  }
};

// Helper: Update context settings in RimChat Prompt Presets JSON
const updateRimChatContext = (limits) => {
  const filePath = findRimChatPromptPresetsFile();
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, message: 'Presets file not found.' };
  }
  
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(data);
    
    // Find active preset or fallback
    const activePreset = json.Presets.find(p => p.Id === json.ActivePresetId) || json.Presets[0];
    if (!activePreset) {
      return { success: false, message: 'No presets found in JSON.' };
    }
    
    const payloads = activePreset.ChannelPayloads || {};
    
    // We will update both Diplomacy and Rpg
    const channels = ['Diplomacy', 'Rpg'];
    
    // Find a non-empty template if either channel's SystemPromptCustomJson is empty
    let fallbackTemplateStr = '';
    for (const p of json.Presets) {
      if (p.ChannelPayloads) {
        if (p.ChannelPayloads.Diplomacy && p.ChannelPayloads.Diplomacy.SystemPromptCustomJson && p.ChannelPayloads.Diplomacy.SystemPromptCustomJson.length > 50) {
          fallbackTemplateStr = p.ChannelPayloads.Diplomacy.SystemPromptCustomJson;
          break;
        }
        if (p.ChannelPayloads.Rpg && p.ChannelPayloads.Rpg.SystemPromptCustomJson && p.ChannelPayloads.Rpg.SystemPromptCustomJson.length > 50) {
          fallbackTemplateStr = p.ChannelPayloads.Rpg.SystemPromptCustomJson;
          break;
        }
      }
    }
    
    channels.forEach(ch => {
      if (!payloads[ch]) payloads[ch] = {};
      
      let configObj = {};
      let jsonStr = payloads[ch].SystemPromptCustomJson || '';
      
      if (jsonStr.trim().length > 0) {
        try {
          configObj = JSON.parse(jsonStr);
        } catch (e) {
          configObj = {};
        }
      } else if (fallbackTemplateStr) {
        try {
          configObj = JSON.parse(fallbackTemplateStr);
        } catch (e) {
          configObj = {};
        }
      }
      
      // Ensure path exists
      if (!configObj.EnvironmentPrompt) configObj.EnvironmentPrompt = {};
      if (!configObj.EnvironmentPrompt.SceneSystem) configObj.EnvironmentPrompt.SceneSystem = {};
      if (!configObj.EnvironmentPrompt.EventIntelPrompt) configObj.EnvironmentPrompt.EventIntelPrompt = {};
      if (!configObj.PromptPolicy) configObj.PromptPolicy = {};
      
      // Update values
      configObj.EnvironmentPrompt.SceneSystem.MaxSceneChars = parseInt(limits.maxSceneChars);
      configObj.EnvironmentPrompt.SceneSystem.MaxTotalChars = parseInt(limits.maxTotalChars);
      configObj.EnvironmentPrompt.EventIntelPrompt.MaxInjectedChars = parseInt(limits.maxInjectedChars);
      configObj.PromptPolicy.SummaryCharBudget = parseInt(limits.summaryCharBudget);
      
      payloads[ch].SystemPromptCustomJson = JSON.stringify(configObj, null, 4);
    });
    
    fs.writeFileSync(filePath, JSON.stringify(json, null, 4), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

// Integration API: Get RimChat Context config
app.get('/api/rimworld-context', (req, res) => {
  res.json(readRimChatContext());
});

// Integration API: Inject RimChat Context config
app.post('/api/rimworld-context', (req, res) => {
  const limits = req.body;
  if (!limits.maxSceneChars || !limits.maxTotalChars || !limits.maxInjectedChars || !limits.summaryCharBudget) {
    return res.status(400).json({ success: false, message: 'Missing required character limits.' });
  }
  
  const result = updateRimChatContext(limits);
  if (result.success) {
    logToDashboard('success', 'server', `Successfully injected context limits into RimWorld presets file (MaxTotalChars: ${limits.maxTotalChars}, MaxSceneChars: ${limits.maxSceneChars}, MaxInjectedChars: ${limits.maxInjectedChars}, SummaryCharBudget: ${limits.summaryCharBudget})`);
    res.json({ success: true, config: readRimChatContext() });
  } else {
    logToDashboard('error', 'server', `Failed to inject RimWorld context: ${result.message}`);
    res.status(500).json({ success: false, message: result.message });
  }
});

// Integration API: Get RimWorld settings link status
app.get('/api/rimworld-config', (req, res) => {
  const customFilePath = req.query.filePath;
  res.json(readRimMindConfig(customFilePath));
});

// Integration API: Link/Configure RimWorld mod settings file directly
app.post('/api/rimworld-config', async (req, res) => {
  const customFilePath = req.body && req.body.filePath;
  let modelName = req.body && req.body.modelName;
  
  const endpoint = `https://localhost:${config.port}/`;
  const apiKey = config.bridgeApiKey || 'rimmind-bridge';
  
  if (!modelName) {
    const lmStatus = await fetchLMStudioModels();
    if (lmStatus.online && lmStatus.models.length > 0) {
      modelName = lmStatus.models[0].id;
    } else {
      modelName = 'auto';
    }
  }
  
  const result = updateRimMindConfig(endpoint, apiKey, modelName, customFilePath);
  if (result.success) {
    logToDashboard('success', 'server', `Successfully injected configuration into RimWorld settings file (Endpoint: ${endpoint}, Key: ${apiKey}, Model: ${modelName})`);
    res.json({ success: true, config: readRimMindConfig(customFilePath) });
  } else {
    logToDashboard('error', 'server', `Failed to inject RimWorld settings: ${result.message}`);
    res.status(500).json({ success: false, message: result.message });
  }
});

// SSE Endpoint for Live Logs
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  // Send existing history
  res.write(`data: ${JSON.stringify({ type: 'history', logs: logBuffer })}\n\n`);
  
  sseClients.push(res);
  
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Admin API: Get Status
app.get('/api/status', async (req, res) => {
  const lmStatus = await fetchLMStudioModels();
  const activeCtx = await fetchLMStudioActiveContext();
  const gpuStats = await fetchGPUStats();
  
  // Calculate Capacity & Scalability Metrics
  pruneActivePawns();
  const activePawnCount = activePawnsTracker.size;
  const activePawnNames = Array.from(activePawnsTracker.keys());
  
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalDuration = 0;
  const count = recentRequestsMetrics.length;
  
  recentRequestsMetrics.forEach(m => {
    totalPromptTokens += m.promptTokens;
    totalCompletionTokens += m.completionTokens;
    totalDuration += m.durationMs;
  });
  
  const avgPromptTokens = count > 0 ? Math.round(totalPromptTokens / count) : 0;
  const avgCompletionTokens = count > 0 ? Math.round(totalCompletionTokens / count) : 0;
  const avgDurationMs = count > 0 ? Math.round(totalDuration / count) : 0;
  
  // footprint per pawn (default to 1200 if not enough data)
  const tokensPerPawn = (activePawnCount > 0 && avgPromptTokens > 0) 
    ? Math.max(100, Math.round(avgPromptTokens / activePawnCount)) 
    : 1200;
  
  // Get current global context budget
  const contextTarget = (activeCtx && activeCtx.contextLength) 
    ? activeCtx.contextLength 
    : (config.lastAllocatedTokenWindow || 34400);
    
  const maxPawnsByContext = Math.floor(contextTarget / tokensPerPawn);
  
  // Request frequency in last 5 minutes
  const fiveMinutesAgo = Date.now() - 300000;
  const recentCalls = recentRequestsMetrics.filter(m => m.timestamp > fiveMinutesAgo).length;
  const callsPerMinute = parseFloat((recentCalls / 5).toFixed(1));
  
  res.json({
    config,
    queueSize: queue.length,
    processingQueue,
    lmStudio: {
      url: config.lmStudioUrl,
      online: lmStatus.online,
      error: lmStatus.error || null,
      models: lmStatus.models.map(m => m.id),
      activeContext: activeCtx
    },
    gpu: gpuStats,
    capacity: {
      activePawnCount,
      activePawnNames,
      avgPromptTokens,
      avgCompletionTokens,
      avgDurationMs,
      tokensPerPawn,
      maxPawnsByContext,
      callsPerMinute,
      contextTarget
    }
  });
});

// Admin API: Update Config
app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  
  if (newConfig.port !== undefined) config.port = parseInt(newConfig.port);
  if (newConfig.lmStudioUrl !== undefined) config.lmStudioUrl = newConfig.lmStudioUrl;
  if (newConfig.bridgeApiKey !== undefined) config.bridgeApiKey = newConfig.bridgeApiKey;
  if (newConfig.lmStudioApiKey !== undefined) config.lmStudioApiKey = newConfig.lmStudioApiKey;
  if (newConfig.autoMapModel !== undefined) config.autoMapModel = !!newConfig.autoMapModel;
  if (newConfig.sanitizeResponse !== undefined) config.sanitizeResponse = !!newConfig.sanitizeResponse;
  if (newConfig.timeoutMs !== undefined) config.timeoutMs = parseInt(newConfig.timeoutMs);
  
  if (saveConfig()) {
    logToDashboard('success', 'server', 'Configuration updated successfully.');
    res.json({ success: true, config });
  } else {
    res.status(500).json({ success: false, message: 'Failed to write config file.' });
  }
});

// Admin API: Test connection
app.post('/api/test-connection', async (req, res) => {
  const lmStatus = await fetchLMStudioModels();
  res.json(lmStatus);
});

// Helper: Extract and track pawn names from any text content
const trackPawnsFromText = (text) => {
  if (!text) return;
  
  // Patterns for role playing or direct assignment
  const rolePatterns = [
    /You are playing the role of ([A-Z][A-Za-z0-9'-]+)/g,
    /You are ([A-Z][A-Za-z0-9'-]+)/g,
    /name is ([A-Z][A-Za-z0-9'-]+)/g
  ];
  
  // Structured listings in colony reports
  const listingPatterns = [
    /Character:\s*([A-Z][A-Za-z0-9'-]+)/g,
    /Name:\s*([A-Z][A-Za-z0-9'-]+)/g,
    /Pawn:\s*([A-Z][A-Za-z0-9'-]+)/g,
    /-\s*([A-Z][A-Za-z0-9'-]+)\s*\((?:Age|Gender|Health)/g,
    /\*\s*([A-Z][A-Za-z0-9'-]+)\s*:\s*(?:Health|Mood|Age)/g,
    /(?:Colonist|Pawn):\s*([A-Z][A-Za-z0-9'-]+)/gi
  ];

  for (const pattern of rolePatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        const name = match[1].trim();
        if (name && name !== 'Pawn' && name !== 'User' && name !== 'Assistant') {
          activePawnsTracker.set(name, Date.now());
        }
      }
    }
  }

  for (const pattern of listingPatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        const name = match[1].trim();
        if (name && name !== 'Pawn' && name !== 'User' && name !== 'Assistant') {
          activePawnsTracker.set(name, Date.now());
        }
      }
    }
  }
};

// Heuristic deparser to extract readable details from RimWorld LLM requests
const deparseRequest = (body) => {
  if (!body || !body.messages || body.messages.length === 0) {
    return 'Received empty request to LLM';
  }
  
  // Track any pawns found in all request messages
  body.messages.forEach(msg => {
    if (msg.content) {
      trackPawnsFromText(msg.content);
    }
  });

  // Find system prompt
  const systemMsg = body.messages.find(m => m.role === 'system');
  const systemContent = systemMsg ? systemMsg.content : '';
  
  // Find last user message
  const userMessages = body.messages.filter(m => m.role === 'user');
  const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
  
  // Heuristic: Check module type
  const isStoryteller = /storyteller|director|incident|narrator|incidentmaker|threat/i.test(systemContent);
  const isAdvisor = /advisor|helper/i.test(systemContent);
  const isMemory = /summary|summarizer|history|memories/i.test(systemContent);
  
  let tag = '[Personal Conversation]';
  if (isStoryteller) tag = '[Storyteller]';
  else if (isAdvisor) tag = '[Advisor]';
  else if (isMemory) tag = '[Colony Memory]';
  
  if (isStoryteller) {
    return `${tag} Storyteller AI ➔ Began story event processing.`;
  }
  
  if (isAdvisor) {
    return `${tag} Advisor AI ➔ Analyzing colony situation...`;
  }
  
  if (isMemory) {
    return `${tag} Summarizer ➔ Generating memory summary...`;
  }
  
  // Heuristic: Extract Pawn Name from system prompt
  let pawnName = 'Pawn';
  const namePatterns = [
    /You are playing the role of ([A-Za-z0-9\s'-]+?)(?:,|\.|\n|is a|Your traits|$)/i,
    /You are ([A-Za-z0-9\s'-]+?)(?:,|\.|\n|is a|Your traits|\(|\bYour\b|$)/i,
    /name is ([A-Za-z0-9\s'-]+?)(?:,|\.|\n|$)/i,
    /Character:\s*([A-Za-z0-9\s'-]+?)(?:\n|,|\.|$)/i,
    /Name:\s*([A-Za-z0-9\s'-]+?)(?:\n|,|\.|$)/i
  ];
  
  for (const pattern of namePatterns) {
    const match = systemContent.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      pawnName = match[1].trim();
      break;
    }
  }
  
  if (pawnName && pawnName !== 'Pawn') {
    activePawnsTracker.set(pawnName, Date.now());
  }
  
  // Clean up user message (e.g. remove XML/JSON block artifacts or brackets)
  let cleanUserMsg = lastUserMsg.replace(/\[.*?\]/g, '').replace(/<.*?>/g, '').trim();
  if (cleanUserMsg.length > 120) {
    cleanUserMsg = cleanUserMsg.substring(0, 120) + '...';
  }
  
  if (!cleanUserMsg) {
    cleanUserMsg = 'Generating dialogue/action response...';
  }
  
  return `${tag} User ➔ (${pawnName}): "${cleanUserMsg}"`;
};

// Heuristic deparser to extract readable details from RimWorld LLM responses
const deparseResponse = (body, responseContent) => {
  if (!responseContent) return 'LLM returned empty response';
  
  // Track any pawns found in the response content
  trackPawnsFromText(responseContent);

  // Find system prompt
  const systemMsg = body.messages && body.messages.find(m => m.role === 'system');
  const systemContent = systemMsg ? systemMsg.content : '';
  
  const isStoryteller = /storyteller|director|incident|narrator|incidentmaker|threat/i.test(systemContent);
  const isAdvisor = /advisor|helper/i.test(systemContent);
  const isMemory = /summary|summarizer|history|memories/i.test(systemContent);
  
  let tag = '[Personal Conversation]';
  if (isStoryteller) tag = '[Storyteller]';
  else if (isAdvisor) tag = '[Advisor]';
  else if (isMemory) tag = '[Colony Memory]';
  
  if (isStoryteller) {
    let cleanResponse = responseContent.replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '').trim();
    if (cleanResponse.length > 120) {
      cleanResponse = cleanResponse.substring(0, 120) + '...';
    }
    return `${tag} Storyteller AI ➔ Event processed: "${cleanResponse}"`;
  }
  
  if (isAdvisor) {
    let cleanResponse = responseContent.trim();
    
    const mdJsonRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
    const match = cleanResponse.match(mdJsonRegex);
    let parsedContent = match ? match[1].trim() : cleanResponse;
    
    if (parsedContent.startsWith('{') && parsedContent.endsWith('}')) {
      try {
        const parsed = JSON.parse(parsedContent);
        if (parsed.advices && Array.isArray(parsed.advices) && parsed.advices.length > 0) {
          const lines = parsed.advices.map(adv => {
            const target = adv.target || adv.pawn || 'Colony';
            
            // Track the target/pawn name
            if (target && target !== 'Colony') {
              activePawnsTracker.set(target, Date.now());
            }
            
            const reason = adv.reason || 'No reason specified';
            let cleanReason = reason;
            if (cleanReason.length > 100) {
              cleanReason = cleanReason.substring(0, 100) + '...';
            }
            return `${target} (Pawn Thoughts): "${cleanReason}"`;
          });
          return `${tag} Advisor AI ➔ ${lines.join(' | ')}`;
        }
      } catch (e) {
        // Fallback
      }
    }
    
    if (cleanResponse.length > 120) {
      cleanResponse = cleanResponse.substring(0, 120) + '...';
    }
    return `${tag} Advisor AI ➔ Recommendation: "${cleanResponse}"`;
  }
  
  if (isMemory) {
    let cleanResponse = responseContent.trim();
    if (cleanResponse.length > 120) {
      cleanResponse = cleanResponse.substring(0, 120) + '...';
    }
    return `${tag} Summarizer ➔ Memory summary: "${cleanResponse}"`;
  }
  
  // Heuristic: Extract Pawn Name
  let pawnName = 'Pawn';
  const namePatterns = [
    /You are playing the role of ([A-Za-z0-9\s'-]+?)(?:,|\.|\n|is a|Your traits|$)/i,
    /You are ([A-Za-z0-9\s'-]+?)(?:,|\.|\n|is a|Your traits|\(|\bYour\b|$)/i,
    /name is ([A-Za-z0-9\s'-]+?)(?:,|\.|\n|$)/i,
    /Character:\s*([A-Za-z0-9\s'-]+?)(?:\n|,|\.|$)/i,
    /Name:\s*([A-Za-z0-9\s'-]+?)(?:\n|,|\.|$)/i
  ];
  
  for (const pattern of namePatterns) {
    const match = systemContent.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      pawnName = match[1].trim();
      break;
    }
  }
  
  if (pawnName && pawnName !== 'Pawn') {
    activePawnsTracker.set(pawnName, Date.now());
  }
  
  // Clean up assistant response
  let cleanResponse = responseContent.trim();
  
  // Try to clean markdown json code block wrapper if present
  const mdJsonRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = cleanResponse.match(mdJsonRegex);
  let parsedContent = match ? match[1].trim() : cleanResponse;
  
  // If response is JSON, extract content or format nicely (without corrupting with regex first)
  if (parsedContent.startsWith('{') && parsedContent.endsWith('}')) {
    try {
      const parsed = JSON.parse(parsedContent);
      if (parsed.reply) cleanResponse = parsed.reply;
      else if (parsed.message) cleanResponse = parsed.message;
      else if (parsed.response) cleanResponse = parsed.response;
      else if (parsed.content) cleanResponse = parsed.content;
      else if (parsed.dialogue) cleanResponse = parsed.dialogue;
      else if (parsed.narrative) cleanResponse = parsed.narrative;
      else cleanResponse = parsedContent;
    } catch (e) {
      // If parsing fails, fall back to string cleanups
      cleanResponse = parsedContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      cleanResponse = cleanResponse.replace(/\[.*?\]/g, '').replace(/<.*?>/g, '').trim();
    }
  } else {
    // If it's plain text, strip think blocks, brackets and HTML tags
    cleanResponse = cleanResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    cleanResponse = cleanResponse.replace(/\[.*?\]/g, '').replace(/<.*?>/g, '').trim();
  }
  
  if (cleanResponse.length > 120) {
    cleanResponse = cleanResponse.substring(0, 120) + '...';
  }
  
  return `${tag} ${pawnName} ➔ User: "${cleanResponse}"`;
};

// OpenAI proxy routes

// 1. Models List
app.get('/v1/models', async (req, res) => {
  logToDashboard('info', 'proxy', 'Received model list request from RimWorld/client.');
  const lmStatus = await fetchLMStudioModels();
  
  if (lmStatus.online) {
    res.json({ object: 'list', data: lmStatus.models });
  } else {
    logToDashboard('warn', 'proxy', 'LM Studio is offline. Returning fallback model list.');
    // Return a fallback model so RimMind's test connection doesn't break
    res.json({
      object: 'list',
      data: [
        { id: 'lm-studio-offline-fallback', object: 'model', owned_by: 'lm-studio' }
      ]
    });
  }
});

// 2. Chat Completions
app.post('/v1/chat/completions', (req, res) => {
  const requestId = 'req-' + Math.random().toString(36).substr(2, 9);
  const startTimestamp = Date.now();
  const body = req.body;
  
  const requestedModel = body.model;
  const promptSummary = body.messages && body.messages.length > 0 
    ? body.messages[body.messages.length - 1].content 
    : 'No messages';
  
  const requestSummary = deparseRequest(body);
  logToDashboard('info', 'proxy', requestSummary, {
    requestId,
    model: requestedModel,
    promptSummary: promptSummary.substr(0, 100) + (promptSummary.length > 100 ? '...' : '')
  });
  
  // Wrap completion logic in a queued function
  const executeRequest = () => {
    return new Promise(async (resolve) => {
      activeRequests.set(requestId, { startTimestamp, body });
      logToDashboard('info', 'queue', `Executing request [${requestId}] now...`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        logToDashboard('error', 'queue', `Request [${requestId}] timed out after ${config.timeoutMs}ms.`);
        controller.abort();
      }, config.timeoutMs);
      
      try {
        // Auto Map Model Name if active
        let targetModel = requestedModel;
        if (config.autoMapModel) {
          const lmStatus = await fetchLMStudioModels();
          if (lmStatus.online && lmStatus.models.length > 0) {
            // Find active model. LM Studio usually has 1 model loaded, or we just map to the first available loaded model.
            const activeModel = lmStatus.models[0].id;
            if (activeModel && activeModel !== requestedModel) {
              logToDashboard('info', 'proxy', `Auto-mapping requested model "${requestedModel}" to active LM Studio model "${activeModel}".`);
              body.model = activeModel;
              targetModel = activeModel;
            }
          }
        }
        
        // Fix for LM Studio 400 error: 'response_format.type' must be 'json_schema' or 'text'
        if (body.response_format && body.response_format.type === 'json_object') {
          logToDashboard('info', 'proxy', 'Removing unsupported "response_format.type: json_object" to prevent LM Studio 400 error.');
          delete body.response_format;
        }
        
        // If max_tokens is set and is small, increase it to give reasoning models room to think
        if (body.max_tokens && body.max_tokens < 8192) {
          logToDashboard('info', 'proxy', `Increasing max_tokens from ${body.max_tokens} to 8192 to allow reasoning models sufficient tokens.`);
          body.max_tokens = 8192;
        }
        
        logToDashboard('info', 'lm-studio', `Forwarding request [${requestId}] to LM Studio: ${config.lmStudioUrl}/v1/chat/completions`);
        
        // Forward to LM Studio — include auth only if lmStudioApiKey is set
        const proxyHeaders = { 'Content-Type': 'application/json' };
        if (config.lmStudioApiKey) {
          proxyHeaders['Authorization'] = `Bearer ${config.lmStudioApiKey}`;
        }
        
        const response = await fetch(`${config.lmStudioUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: proxyHeaders,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`LM Studio returned ${response.status}: ${text}`);
        }
        
        const responseData = await response.json();
        const duration = Date.now() - startTimestamp;
        
        // Handle reasoning content fallback and sanitization
        if (responseData.choices && responseData.choices[0] && responseData.choices[0].message) {
          const msg = responseData.choices[0].message;
          
          // Fallback to reasoning_content if content is empty (common when reasoning models hit token limit during thinking)
          if ((!msg.content || msg.content.trim() === '') && msg.reasoning_content) {
            logToDashboard('warn', 'proxy', `Assistant content was empty but reasoning_content was present. Using reasoning_content as fallback (length: ${msg.reasoning_content.length} chars).`);
            msg.content = msg.reasoning_content;
          }
          
          if (config.sanitizeResponse) {
            const systemMsg = body.messages && body.messages.find(m => m.role === 'system');
            const systemContent = systemMsg ? systemMsg.content : '';
            const isPawnDialogue = /You are playing the role of|You are ([A-Za-z0-9\s'-]+?) in RimWorld|role-playing as a RimWorld colonist/i.test(systemContent) || 
                                   /dialogue/i.test(systemContent) || 
                                   (body.messages && body.messages.some(m => m.content && m.content.includes('Mood changed')));
            
            const originalContent = msg.content;
            const cleanedContent = sanitizeMessageContent(originalContent, isPawnDialogue);
            msg.content = cleanedContent;
          }
        }
        
        const promptTokens = responseData.usage ? responseData.usage.prompt_tokens : 0;
        const completionTokens = responseData.usage ? responseData.usage.completion_tokens : 0;
        
        const responseSummary = deparseResponse(body, responseData.choices[0].message.content);
        logToDashboard('success', 'proxy', responseSummary, {
          requestId,
          durationMs: duration,
          model: targetModel,
          promptTokens,
          completionTokens,
          response: responseData.choices && responseData.choices[0] && responseData.choices[0].message 
            ? responseData.choices[0].message.content.substr(0, 150) + '...'
            : 'No response text'
        });
        
        res.json(responseData);
      } catch (err) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTimestamp;
        logToDashboard('error', 'proxy', `Request [${requestId}] failed in ${duration}ms: ${err.message}`);
        
        res.status(500).json({
          error: {
            message: `RimMind Bridge Error: ${err.message}`,
            type: 'bridge_error',
            param: null,
            code: 'internal_error'
          }
        });
      } finally {
        activeRequests.delete(requestId);
        resolve();
      }
    });
  };
  
  // Push to queue
  queue.push(executeRequest);
  
  // Trigger processing
  processQueue();
});

// Fallback error handler
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.status(500).json({ error: { message: err.message } });
});

// Background Keep-Alive Ping to prevent LM Studio from auto-unloading models
const startLMStudioKeepAlive = () => {
  console.log('[server] Initializing background LM Studio keep-alive ping loop (every 4 minutes)...');
  setInterval(async () => {
    try {
      const lmStatus = await fetchLMStudioModels();
      if (lmStatus.online && lmStatus.models.length > 0) {
        const activeModel = lmStatus.models[0].id;
        const headers = { 'Content-Type': 'application/json' };
        if (config.lmStudioApiKey) {
          headers['Authorization'] = `Bearer ${config.lmStudioApiKey}`;
        }
        
        const response = await fetch(`${config.lmStudioUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: activeModel,
            messages: [{ role: 'user', content: 'keep-alive ping' }],
            max_tokens: 1
          })
        });
        
        if (response.ok) {
          console.log(`[lm-studio] Sent stateless 1-token keep-alive ping to "${activeModel}"`);
        }
      }
    } catch (err) {
      // Suppress background ping errors
    }
  }, 240000); // Run every 4 minutes (240s)
};

// Write helper PowerShell script on load
writePsScript();

// Start Server — HTTPS if certificate.pfx exists, otherwise HTTP fallback
const PFX_PATH = path.join(__dirname, 'certificate.pfx');
const PFX_PASS = 'rimmind-bridge';

if (fs.existsSync(PFX_PATH)) {
  const pfx = fs.readFileSync(PFX_PATH);
  const httpsServer = https.createServer({ pfx, passphrase: PFX_PASS }, app);
  httpsServer.listen(config.port, () => {
    logToDashboard('success', 'server', `RimSynapse Bridge started on HTTPS port ${config.port}`);
    logToDashboard('info', 'server', `Dashboard: https://localhost:${config.port}`);
    logToDashboard('info', 'server', `Set RimWorld endpoint to: https://localhost:${config.port}/`);
    logToDashboard('info', 'server', `Target LM Studio URL: ${config.lmStudioUrl}`);
    startLMStudioKeepAlive();
  });
} else {
  logToDashboard('warn', 'server', 'certificate.pfx not found — starting in plain HTTP mode.');
  logToDashboard('info', 'server', 'Run "npm run setup-certs" to generate a trusted certificate.');
  const httpServer = app.listen(config.port, () => {
    logToDashboard('success', 'server', `RimSynapse Bridge started on HTTP port ${config.port}`);
    logToDashboard('info', 'server', `Dashboard: http://localhost:${config.port}`);
    logToDashboard('info', 'server', `Set RimWorld endpoint to: http://localhost:${config.port}/`);
    logToDashboard('info', 'server', `Target LM Studio URL: ${config.lmStudioUrl}`);
    startLMStudioKeepAlive();
  });
}
