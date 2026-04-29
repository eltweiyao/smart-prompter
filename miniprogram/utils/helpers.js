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
  SEARCH_WINDOW_BEFORE: 40,
  SEARCH_WINDOW_AFTER: 260,
  RECOVERY_SEARCH_WINDOW_BEFORE: 80,
  RECOVERY_SEARCH_WINDOW_AFTER: 420,
  RECOVERY_TAIL_LENGTH: 50,
  RECOVERY_FRAME_COUNT: 3,
  CONFIDENCE_THRESHOLD: 0.5,
  POSITION_DIFF_MIN: -30,
  POSITION_DIFF_MAX: 150,
  RECOVERY_POSITION_DIFF_MIN: -60,
  RECOVERY_POSITION_DIFF_MAX: 320,
  BASE_SPEED: 40,
  RECORD_DURATION: 60000,
  CAMERA_RECORD_MAX_DURATION: 300,
  SMART_FOLLOW_TICK_MS: 80,
  SMART_SILENCE_HOLD_MS: 1800,
  SMART_SPEECH_RESUME_GRACE_MS: 1800,
  SMART_MIN_ACTIVE_DELTA_LENGTH: 4,
  DELTA_CONFIDENCE_THRESHOLD: 0.6,
  CONTEXT_CONFIDENCE_THRESHOLD: 0.68
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
 * 处理台本内容 - 删除所有换行符
 */
function processContent(content) {
  if (!content) return '';

  return content
    .replace(/[\r\n]+/g, '')
    .trim();
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
