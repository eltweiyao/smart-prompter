# 随声提词 - 跟随算法分析报告

## 算法概览

这是"随声提词"微信小程序的语音跟随算法，核心流程：

```
ASR 语音识别 → 提取增量文本(delta) → SmartMatcher.match() 匹配脚本位置 → 滚动到对应行
```

关键文件：
- `miniprogram/utils/matcher.js` — 核心匹配算法 (SmartMatcher)
- `miniprogram/pages/prompter/prompter.js` — 提词器页面，集成 ASR 和滚动控制
- `miniprogram/utils/helpers.js` — 配置常量和文本归一化

---

## 需要改进的问题

### P0 - 关键问题（急需修复）

#### 1. `tick()` 空操作 (`matcher.js:244-247`)

```javascript
tick() {
  this.lastTickTime = Date.now();
  return null;  // 永远返回 null
}
```

**问题**：`prompter.js:497-504` 每 500ms 调用一次 `tick()`，但始终返回 null，没有任何推进效果。当用户暂停说话（思考、喝水）时，画面完全静止，体验不好。

**建议**：实现渐进式时间推进——当用户停顿超过一定时间（如 3-5 秒），以较慢的速度自动推进，避免画面完全卡死：

```javascript
tick() {
  const now = Date.now();
  const silenceDuration = (now - this.lastSpeechTime) / 1000;

  if (silenceDuration > 3) { // 停顿超过3秒
    const silenceSpeed = this.baseSpeed * 0.3; // 慢速推进
    const elapsed = (now - this.lastTickTime) / 1000;
    const cleanLength = this.cleanScript.length;
    const timeProgress = Math.min(
      (this.currentPosition + elapsed * silenceSpeed) / cleanLength,
      0.95
    );
    this.lastTickTime = now;
    return timeProgress;
  }

  this.lastTickTime = now;
  return null;
}
```

#### 2. Fallback 匹配逻辑问题 (`prompter.js:457-460`)

```javascript
const fallbackText = text.slice(-20);
if (progress === null && fallbackText && fallbackText !== delta) {
  progress = this.matcher.match(fallbackText);
}
```

**问题**：`matcher.match()` 的设计意图是处理增量文本（delta），但 fallback 传入的是累积文本的尾部 20 个字符。当 `lastRecognizedLength` 被重置（ASR 重启）时，delta 可能是整个文本，这 20 字符的 fallback 和 delta 可能相同，白白浪费一次匹配。

**建议**：在 ASR 重启场景下，应该用整个 recognized text（或至少更长的片段）来匹配，而不是固定 20 字符。同时记录是否处于"重启恢复期"，在恢复期使用更宽松的搜索窗口。

---

### P1 - 重要问题

#### 3. ASR 重置检测逻辑有缺陷 (`matcher.js:109-118`)

```javascript
// 当前逻辑：需要 consecutiveSameCount > 0 才触发
if (similarity > 0.7 && this.consecutiveSameCount > 0) {
  this.consecutiveSameCount++;
  return this.getProgress();
}
```

**问题**：ASR 引擎重启后，第一帧文本是全新的（不等于 `lastAsrText`），所以 `consecutiveSameCount` 会被重置为 0，导致重置检测失效。只有当 ASR 重复输出相同文本时才能检测到，但重启后第一帧通常是不同的。

**建议**：增加一个"ASR 重启"的显式检测，比如当 delta 长度突然变短（从很长变为很短）且内容与脚本开头相似时，判定为重启。

#### 4. 搜索窗口不对称 (`helpers.js:19-20`)

```
SEARCH_WINDOW_BEFORE: 20,   // 向前只看 20 字符
SEARCH_WINDOW_AFTER: 200,   // 向后看 200 字符
```

**问题**：向前窗口仅 20 字符太小。如果用户语速较快或 ASR 有延迟，当前位置可能已经落后于实际朗读位置 20+ 字符，此时向前搜索 20 字符不够。

**建议**：将 `SEARCH_WINDOW_BEFORE` 增加到 50-80，或根据最近的匹配速度动态调整窗口大小。

#### 5. 索引转换性能差 (`matcher.js:45-68`)

`toCleanIndex` 和 `toOriginalIndex` 每次都从头遍历，O(n) 复杂度。在长文本（如 10000+ 字符的剧本）中频繁调用会影响性能。

**建议**：维护一个预计算的映射表（clean index → original index），在构造时一次性计算：

```javascript
constructor(script, startIndex = 0) {
  // ...
  this.cleanToOriginal = [];
  this.originalToClean = [];
  for (let i = 0; i < script.length; i++) {
    if (CLEAN_REGEX.test(script[i])) {
      this.cleanToOriginal.push(i);
    }
  }
  // originalToClean 可以反向构建
}
```

---

### P2 - 次要改进

#### 6. `calculateSimilarity` 太简单 (`matcher.js:161-169`)

```javascript
calculateSimilarity(str1, str2) {
  const len = Math.min(str1.length, str2.length);
  let matches = 0;
  for (let i = 0; i < len; i++) {
    if (str1[i] === str2[i]) matches++;
  }
  return matches / len;
}
```

**问题**：逐字符位置比较，ASR 经常会重新排列词序，这种相似度算法会误判为低相似度。

**建议**：改用基于字符集合的 Jaccard 相似度或编辑距离：

```javascript
// Jaccard 相似度（对词序变化更鲁棒）
calculateSimilarity(str1, str2) {
  const set1 = new Set(str1.split(''));
  const set2 = new Set(str2.split(''));
  let intersection = 0;
  for (const c of set1) {
    if (set2.has(c)) intersection++;
  }
  return intersection / (set1.size + set2.size - intersection);
}
```

#### 7. 置信度计算忽略匹配质量 (`matcher.js:219-238`)

**问题**：当前置信度只看两个维度：匹配长度和位置距离。不区分"精确匹配"和"部分匹配"（子串匹配）。

**建议**：给精确匹配更高的置信度加成：

```javascript
// 增加匹配类型权重
if (matchedLen === deltaLength) {
  confidence += 0.15; // 完整匹配 delta，额外加分
}
```

#### 8. 仅向前滚动，无法纠正过度推进 (`prompter.js:361-366`)

```javascript
updateSmartFollowOffset: function(progress) {
  const targetOffset = this.getSmartFollowOffset(progress);
  if (targetOffset < this.data.offsetY) {  // 只能往前走
    this.setData({ offsetY: targetOffset });
  }
}
```

**问题**：如果 ASR 误识别导致位置跳得太远，画面会卡在一个不正确的位置，永远无法回退。

**建议**：增加小幅回退能力——当新匹配的位置明显在当前位置之前（如超过 3 行），允许小幅度回退（比如最多回退 1-2 行）。

---

### P3 - 细节优化

#### 9. 重复文本匹配歧义

**问题**：如果脚本中有重复短语（如"谢谢大家"出现多次），`findBestMatch` 用 `indexOf` 会匹配第一个出现的位置，但用户可能已经读到后面的位置了。

**建议**：`indexOf` 搜索从 `currentPosition` 开始而不是从 `searchStart`（当前是 `currentPosition - 20`），确保优先匹配当前位置之后的文本。或者在找到多个匹配时，选择离当前位置最近的那个。

#### 10. `processContent` 删除所有换行符 (`helpers.js:50-56`)

```javascript
function processContent(content) {
  return content.replace(/[\r\n]+/g, '').trim();
}
```

**问题**：删除换行符会丢失段落结构信息，影响行数估算的准确性。虽然匹配时 normalizeText 也删除了换行，但视觉上的行数估算依赖于原始文本的换行结构。

**建议**：在行数估算时保留换行信息，只在匹配时删除换行。

---

## 改进优先级总结

| 优先级 | 问题 | 影响 | 改进难度 |
|--------|------|------|---------|
| **P0** | tick() 空操作，停顿时画面卡死 | 用户体验严重受损 | 低 |
| **P0** | Fallback 匹配逻辑问题 | ASR 重启后可能丢失位置 | 中 |
| **P1** | ASR 重置检测失效 | 长文本跟随中断 | 中 |
| **P1** | 搜索窗口不对称 | 快速朗读时跟不上 | 低 |
| **P1** | 索引转换性能差 | 长文本卡顿 | 低 |
| **P2** | calculateSimilarity 太简单 | 误匹配/漏匹配 | 低 |
| **P2** | 置信度不区分匹配质量 | 匹配精度 | 低 |
| **P2** | 无法回退纠正 | ASR 误识别后卡住 | 中 |
| **P3** | 重复文本歧义 | 特定场景问题 | 中 |
| **P3** | processContent 删换行 | 行数估算偏差 | 低 |
