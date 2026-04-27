/**
 * 公共工具函数
 */

// Storage Key 常量
const STORAGE_KEYS = {
  SCRIPTS: 'scripts',
  HISTORY: 'script_history',
  SETTINGS: 'prompter_settings',
  TEMP_SCRIPT: 'temp_prompter_script',
  GUIDE_SEEN: 'hasSeenGuide'
};

// Magic Numbers
const CONFIG = {
  MAX_HISTORY_COUNT: 10,
  MIN_CONTENT_LENGTH: 2,
  MATCH_MIN_LENGTH: 3,  // 识别文本最小长度
  MATCH_MAX_LENGTH: 20,
  SEARCH_WINDOW_BEFORE: 20,
  SEARCH_WINDOW_AFTER: 200,
  CONFIDENCE_THRESHOLD: 0.5,
  POSITION_DIFF_MIN: -30,
  POSITION_DIFF_MAX: 150,
  BASE_SPEED: 40,
  RECORD_DURATION: 60000
};

/**
 * 规范化文本 - 移除特殊字符
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .replace(/\s+/g, '');
}

/**
 * 格式化日期显示
 */
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * 处理台本内容 - 面向提词场景的温和整理
 *
 * 规则：
 * 1. 统一换行和空格，去掉每行首尾空白
 * 2. 保留空行作为段落分隔，但最多保留一个空行
 * 3. 合并复制粘贴产生的碎换行
 * 4. 按句末标点重新断行，方便提词时掌握节奏
 */
function processContent(content) {
  if (!content) return '';

  const normalized = content
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/)
    .map(formatParagraph)
    .filter(Boolean)
    .join('\n\n');
}

function formatParagraph(paragraph) {
  const text = paragraph
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
    .replace(/\s+([，。！？；：、,.!?;:])/g, '$1')
    .replace(/([，。！？；：、])\s+([\u4e00-\u9fa5])/g, '$1$2')
    .replace(/([（《“‘])\s+/g, '$1')
    .replace(/\s+([）》”’])/g, '$1')
    .trim();

  if (!text) return '';

  return text
    .replace(/([。！？!?；;])\s*/g, '$1\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 检查文本是否有效（用于语音识别结果验证）
 */
function isValidText(text) {
  const clean = normalizeText(text);
  return clean && clean.length >= CONFIG.MIN_CONTENT_LENGTH;
}

module.exports = {
  STORAGE_KEYS,
  CONFIG,
  normalizeText,
  formatDate,
  processContent,
  isValidText
};
