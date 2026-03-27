/**
 * AnchorTextMatcher - 智能跟随核心算法
 * 还原至稳定版本：仅包含索引映射，确保清洗文本与原始文本进度一致
 */
class AnchorTextMatcher {
  constructor(fullScript, startIndex = 0) {
    this.originalScript = fullScript;
    this.script = '';
    this.indexMap = []; 

    for (let i = 0; i < fullScript.length; i++) {
      const char = fullScript[i];
      if (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(char)) {
        this.script += char;
        this.indexMap.push(i);
      }
    }

    this.scriptLength = this.script.length;
    this.lastCleanedIndex = 0;
    for (let i = 0; i < this.indexMap.length; i++) {
      if (this.indexMap[i] >= startIndex) {
        this.lastCleanedIndex = i;
        break;
      }
    }

    this.buffer = '';
    this.searchWindow = 80; 
  }

  match(textDelta) {
    if (!textDelta) return null;
    const cleanDelta = textDelta.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    if (!cleanDelta) return null;

    this.buffer += cleanDelta;
    if (this.buffer.length > 40) this.buffer = this.buffer.slice(-40);

    const windowEnd = Math.min(this.scriptLength, this.lastCleanedIndex + this.searchWindow);
    const scriptWindow = this.script.substring(this.lastCleanedIndex, windowEnd);
    
    const maxSuffixLen = Math.min(this.buffer.length, 15);
    for (let len = maxSuffixLen; len >= 2; len--) {
      const suffix = this.buffer.slice(-len);
      const isCJK = /[\u4e00-\u9fa5]/.test(suffix);
      if (!isCJK && len < 4) continue; 

      const idx = scriptWindow.indexOf(suffix);
      if (idx !== -1) {
        const distance = idx;
        let maxAllowedDist = isCJK ? 40 : 25; 

        if (len >= 8) maxAllowedDist = 120;
        else if (len >= 5) maxAllowedDist = 60;

        if (distance <= maxAllowedDist) {
            const newCleanedIndex = this.lastCleanedIndex + idx + len;
            if (newCleanedIndex > this.lastCleanedIndex) {
              this.lastCleanedIndex = newCleanedIndex;
              const originalIndex = this.indexMap[Math.min(newCleanedIndex, this.indexMap.length - 1)];
              return originalIndex / this.originalScript.length;
            }
        }
      }
    }
    return null;
  }
}

module.exports = AnchorTextMatcher;
