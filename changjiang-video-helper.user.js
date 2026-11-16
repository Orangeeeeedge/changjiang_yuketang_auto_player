// ==UserScript==
// @name         长江雨课堂连续播放助手
// @namespace    local.changjiang.video-helper
// @version      1.1.0
// @description  失焦保护、最高 16 倍速、结束后自动下一节；支持记忆倍速和指定下一节按钮。
// @match        https://changjiang.yuketang.cn/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.__changjiangVideoHelper) return;
  window.__changjiangVideoHelper = true;

  // 页面未提供真实播放器 DOM，因此不假定某个雨课堂版本的内部类名。
  const KEY = 'cj-video-helper:v1';
  const PENDING_KEY = 'cj-video-helper:pending';
  const PANEL_ID = 'cj-video-helper-panel';
  const NEXT_DELAY = 2000;
  const SPEEDS = [0.5, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
  // 保存原生接口，面板显示浏览器报告的速度，而不是播放器菜单的文字。
  const rateDescriptors = Object.fromEntries(['playbackRate', 'defaultPlaybackRate'].map(name =>
    [name, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name)]));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
  const config = {
    enabled: saved.enabled !== false,
    autoNext: saved.autoNext !== false,
    playbackRate: SPEEDS.includes(Number(saved.playbackRate)) ? Number(saved.playbackRate) : 1,
    lockRate: saved.lockRate === true,
    nextSelector: typeof saved.nextSelector === 'string' ? saved.nextSelector : '',
    nextText: typeof saved.nextText === 'string' ? saved.nextText : '',
    nextTag: typeof saved.nextTag === 'string' ? saved.nextTag : ''
  };
  const nativeHidden = findGetter('hidden');
  const nativeVisibility = findGetter('visibilityState');
  const nativeHasFocus = document.hasFocus.bind(document);
  let video = null;
  let binding = null;
  let nextTimer = 0;
  let nextAttempted = false;
  let scanTimer = 0;
  let panel = null;
  let statusNode = null;
  let toggleButton = null;
  let nextCheckbox = null;
  let speedSelect = null;
  let speedLockCheckbox = null;
  let speedStatusNode = null;
  let rateTimer = 0;
  let detachRateGuards = () => {};
  let rateError = '';
  let selecting = false;
  let status = '等待课程视频加载';
  let lastFocusLoss = -Infinity;
  let focusGeneration = 0;
  let recoveredGeneration = -1;
  let lastManualControl = -Infinity;
  let lastURL = location.href;
  let pendingStart = readPending();

  function findGetter(key) {
    for (let obj = document; obj; obj = Object.getPrototypeOf(obj)) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      if (descriptor?.get) return descriptor.get.bind(document);
    }
    return () => undefined;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(config)); } catch {}
  }
  function readPending() {
    try { return Number(sessionStorage.getItem(PENDING_KEY)) > Date.now(); }
    catch { return false; }
  }
  function setPending(value) {
    pendingStart = value;
    try {
      if (value) sessionStorage.setItem(PENDING_KEY, String(Date.now() + 45000));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch {}
  }
  function protectedNow() {
    return config.enabled && !!video?.isConnected;
  }
  function setStatus(message) {
    status = message;
    if (statusNode && statusNode.textContent !== message) statusNode.textContent = message;
  }
  function restoreStatus() {
    if (!config.enabled) return setStatus('辅助已停止');
    if (!video) return setStatus('等待课程视频加载');
    setStatus(video.ended ? '视频已结束' : video.paused ? '已暂停，点击“播放 / 继续”' : '播放中，失焦保护已启用');
  }
  function clearNext() {
    clearTimeout(nextTimer);
    nextTimer = 0;
  }

  // 仅在已找到视频且辅助开启时报告可见状态；关闭辅助后恢复原始读数。
  for (const [name, getter, value] of [
    ['hidden', nativeHidden, false],
    ['visibilityState', nativeVisibility, 'visible'],
    ['webkitHidden', findGetter('webkitHidden'), false],
    ['webkitVisibilityState', findGetter('webkitVisibilityState'), 'visible']
  ]) {
    if (getter() === undefined) continue;
    try {
      Object.defineProperty(document, name, {
        configurable: true,
        get: () => protectedNow() ? value : getter()
      });
    } catch (error) { console.warn('[连续播放助手] 无法覆盖', name, error); }
  }
  try {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => protectedNow() || nativeHasFocus()
    });
  } catch (error) { console.warn('[连续播放助手] 无法覆盖 hasFocus', error); }

  // 不拦截输入框失焦，也不阻止页面离开、刷新、正常销毁。
  function onFocusLoss(event) {
    const boundaryMouse = /^(mouse|pointer)(out|leave)$/.test(event.type) && event.relatedTarget == null;
    const windowBlur = event.type === 'blur' && (event.target === window || event.target === document);
    const visibility = /visibilitychange$/.test(event.type);
    if (!protectedNow() || !(boundaryMouse || windowBlur || visibility)) return;
    if (boundaryMouse || windowBlur || nativeHidden()) {
      lastFocusLoss = performance.now();
      focusGeneration++;
    }
    event.stopImmediatePropagation();
  }
  for (const type of ['blur', 'visibilitychange', 'webkitvisibilitychange', 'mouseout', 'mouseleave', 'pointerout', 'pointerleave']) {
    window.addEventListener(type, onFocusLoss, true);
  }

  function visible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function disabled(element) {
    return !!element.closest('[disabled], [aria-disabled="true"], [inert], .disabled, .is-disabled');
  }
  function hasDialog() {
    return [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], .el-dialog__wrapper, .ant-modal-wrap')]
      .some(visible);
  }
  function sourceOf(element) {
    return element.currentSrc || element.getAttribute('src') || element.querySelector('source')?.src || '';
  }
  function readRate(element, name = 'playbackRate') {
    try { return rateDescriptors[name]?.get?.call(element) ?? element[name]; }
    catch { return NaN; }
  }
  function writeRate(element, name, value) {
    if (Math.abs(readRate(element, name) - value) < 0.001) return;
    if (rateDescriptors[name]?.set) rateDescriptors[name].set.call(element, value);
    else element[name] = value;
  }
  function updateSpeedStatus() {
    if (!speedStatusNode) return;
    const actual = video ? readRate(video) : NaN;
    const message = !video ? `目标 ${config.playbackRate}×，等待视频` :
      `${config.enabled ? '当前' : '辅助已停，当前'} ${Number.isFinite(actual) ? actual : '未知'}×` +
      (rateError ? `；浏览器未接受 ${config.playbackRate}×` :
        config.enabled && config.lockRate && Math.abs(actual - config.playbackRate) > 0.001 ? `；目标 ${config.playbackRate}× 尚未生效` : '');
    if (speedStatusNode.textContent !== message) speedStatusNode.textContent = message;
  }
  function applyPlaybackRate(element, force = false) {
    if (!element || element !== video || !config.enabled || (!force && !config.lockRate)) {
      updateSpeedStatus();
      return;
    }
    rateError = '';
    try {
      writeRate(element, 'playbackRate', config.playbackRate);
      writeRate(element, 'defaultPlaybackRate', config.playbackRate);
    } catch (error) { rateError = error.name || 'Error'; }
    updateSpeedStatus();
  }
  function installRateGuards(element) {
    const cleanup = [];
    for (const [name, descriptor] of Object.entries(rateDescriptors)) {
      if (!descriptor?.get || !descriptor?.set) continue;
      const original = Object.getOwnPropertyDescriptor(element, name);
      if (original && !original.configurable) continue;
      const get = () => descriptor.get.call(element);
      const set = value => {
        const requested = config.enabled && config.lockRate && element === video ? config.playbackRate : value;
        // 相同速度不重复写入，避免播放器监听 ratechange 后反复重设导致事件循环。
        if (typeof requested === 'number' && Math.abs(get() - requested) < 0.001) return;
        descriptor.set.call(element, requested);
      };
      try {
        Object.defineProperty(element, name, { configurable: true, enumerable: descriptor.enumerable, get, set });
        cleanup.push(() => {
          const current = Object.getOwnPropertyDescriptor(element, name);
          if (current?.get !== get || current?.set !== set) return;
          if (original) Object.defineProperty(element, name, original);
          else delete element[name];
        });
      } catch {}
    }
    return () => cleanup.forEach(restore => restore());
  }
  async function requestPlay(element) {
    if (!config.enabled || element !== video || !element.isConnected || element.ended || hasDialog()) return;
    applyPlaybackRate(element);
    try {
      await element.play();
      if (element === video && !element.paused) setStatus('播放中，失焦保护已启用');
    } catch (error) {
      if (element !== video || !config.enabled) return;
      setStatus(error.name === 'NotAllowedError'
        ? '浏览器拦截了自动播放，请点击“播放 / 继续”'
        : '暂时无法播放，请在原播放器中重试');
    }
  }
  function onManualControl(event) {
    if (!event.isTrusted || !video) return;
    const shell = video.closest('.video-js, .xgplayer, .video-player, .prism-player, [data-player]') || video.parentElement;
    if (shell?.contains(event.target) || (event.type === 'keydown' && [' ', 'k', 'K', 'MediaPlayPause'].includes(event.key))) {
      lastManualControl = performance.now();
    }
  }
  window.addEventListener('pointerdown', onManualControl, true);
  window.addEventListener('keydown', onManualControl, true);

  function bindVideo(element) {
    binding?.abort();
    detachRateGuards();
    detachRateGuards = () => {};
    clearTimeout(rateTimer);
    rateTimer = 0;
    rateError = '';
    clearNext();
    nextAttempted = false;
    video = element;
    if (!element) { updateSpeedStatus(); return restoreStatus(); }
    detachRateGuards = installRateGuards(element);
    binding = new AbortController();
    const signal = binding.signal;
    let wasPlaying = !element.paused;
    const listen = (name, listener) => element.addEventListener(name, listener, { signal });
    listen('playing', () => {
      wasPlaying = true;
      nextAttempted = false;
      clearNext();
      setPending(false);
      applyPlaybackRate(element);
      setStatus(config.enabled ? '播放中，失焦保护已启用' : '辅助已停止，视频由你手动播放');
    });
    listen('pause', () => {
      const shouldRecover = config.enabled && wasPlaying && !element.ended && !element.error &&
        performance.now() - lastFocusLoss < 1200 && performance.now() - lastManualControl > 1500 &&
        recoveredGeneration !== focusGeneration && !hasDialog();
      wasPlaying = false;
      if (shouldRecover) {
        recoveredGeneration = focusGeneration;
        const originalSource = sourceOf(element);
        setTimeout(() => {
          if (element === video && sourceOf(element) === originalSource && element.paused &&
              performance.now() - lastManualControl > 1500 && !hasDialog()) requestPlay(element);
        }, 150);
      } else if (!element.ended) restoreStatus();
    });
    listen('ended', scheduleNext);
    listen('ratechange', () => {
      updateSpeedStatus();
      if (!config.enabled || !config.lockRate || rateTimer) return;
      rateTimer = setTimeout(() => {
        rateTimer = 0;
        if (element === video) applyPlaybackRate(element);
      }, 100);
    });
    listen('loadstart', () => {
      wasPlaying = false;
      nextAttempted = false;
      clearNext();
      if (config.enabled) setStatus('正在加载视频');
    });
    listen('loadedmetadata', () => {
      clearNext();
      applyPlaybackRate(element, true);
      if (config.enabled && !element.ended) requestPlay(element);
    });
    listen('canplay', () => {
      if (pendingStart && config.enabled) requestPlay(element);
    });
    listen('error', () => setStatus('视频加载失败，请检查原播放器'));
    applyPlaybackRate(element, true);
    restoreStatus();
    if (element.ended) scheduleNext();
    else if (config.enabled) requestPlay(element);
  }

  function nextLabel(element) {
    return [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
      .filter(Boolean).map(value => value.replace(/\s+/g, ' ').trim());
  }
  function targetText(element) {
    return (nextLabel(element)[0] || '').replace(/[：:].*$/, '').trim();
  }
  function findNext() {
    if (config.nextSelector) {
      try {
        const matches = [...document.querySelectorAll(config.nextSelector)]
          .filter(element => visible(element) && !disabled(element) && !panel?.contains(element) &&
            (!config.nextTag || element.localName === config.nextTag) &&
            (!config.nextText || targetText(element) === config.nextText));
        if (matches.length === 1) return matches[0];
      } catch {}
      setStatus('指定的按钮已失效，请重新指定下一节按钮');
      return null;
    }
    const labelPattern = /^(?:下一(?:个)?(?:节(?:课)?|课(?:时)?|讲|视频)|下个视频|next(?:\s+(?:video|lesson|lecture))?)(?:\s*[：:（(].*|\s*[>›»→])?$/i;
    let candidates = [...document.querySelectorAll('button, a, [role="button"], [title], [aria-label], [class*="next"], [class*="Next"]')]
      .filter(element => !panel?.contains(element) && visible(element) && !disabled(element) && nextLabel(element).some(label => labelPattern.test(label)));
    // 同一个按钮内部的图标与文字只算一个候选。
    candidates = candidates.filter(element => !candidates.some(other => other !== element && other.contains(element)));
    if (candidates.length === 1) return candidates[0];
    setStatus(candidates.length ? '发现多个下一节按钮，请手动指定' : '未找到下一节，可能已到末尾；也可手动指定按钮');
    return null;
  }
  function scheduleNext() {
    clearNext();
    if (!config.enabled || !config.autoNext || !video?.ended || selecting || nextAttempted) return;
    const endedVideo = video;
    const source = sourceOf(video);
    const url = location.href;
    setStatus('视频已结束，2 秒后尝试切换下一节');
    nextTimer = setTimeout(() => {
      nextTimer = 0;
      if (!config.enabled || !config.autoNext || selecting || video !== endedVideo ||
          !endedVideo.isConnected || !endedVideo.ended || sourceOf(endedVideo) !== source || location.href !== url) return;
      if (hasDialog()) return setStatus('页面有弹窗，请处理后继续');
      const target = findNext();
      if (!target) return;
      nextAttempted = true;
      setPending(true);
      setStatus('已点击下一节，等待视频加载');
      target.click();
    }, NEXT_DELAY);
  }

  function selectorFor(element) {
    const unique = selector => document.querySelectorAll(selector).length === 1;
    if (element.id) {
      const selector = '#' + CSS.escape(element.id);
      if (unique(selector)) return selector;
    }
    for (const name of ['data-testid', 'data-test', 'data-action', 'aria-label', 'title']) {
      const value = element.getAttribute(name);
      if (value) {
        const selector = `${element.localName}[${name}=${CSS.escape(value)}]`;
        if (unique(selector)) return selector;
      }
    }
    const classes = [...element.classList].filter(value => !/active|selected|disabled|hover|focus|current|^is-/.test(value));
    if (classes.length) {
      const selector = element.localName + classes.map(value => '.' + CSS.escape(value)).join('');
      if (unique(selector)) return selector;
    }
    const parts = [];
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const siblings = [...node.parentElement.children].filter(other => other.localName === node.localName);
      parts.unshift(node.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''));
    }
    return 'body > ' + parts.join(' > ');
  }
  function pickNext(event) {
    if (!selecting || panel?.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.target.closest('button, a, [role="button"], [onclick], .btn-next, .next-btn') || event.target;
    if (element === document.body || element === document.documentElement) {
      return setStatus('请点击具体的下一节按钮；Esc 取消');
    }
    config.nextSelector = selectorFor(element);
    config.nextText = targetText(element);
    config.nextTag = element.localName;
    selecting = false;
    document.documentElement.style.cursor = '';
    save();
    setStatus('已记住下一节按钮；视频结束后会尝试点击');
    if (video?.ended) scheduleNext();
  }
  window.addEventListener('click', pickNext, true);
  window.addEventListener('keydown', event => {
    if (selecting && event.key === 'Escape') {
      selecting = false;
      document.documentElement.style.cursor = '';
      restoreStatus();
    }
  }, true);

  function createPanel() {
    if (!document.body || panel?.isConnected) return;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:270px;padding:14px;background:#172033;color:#fff;border-radius:10px;box-shadow:0 4px 24px #0005;font:13px/1.6 sans-serif;text-align:left;';
    panel.innerHTML = '<div style="font-weight:bold;margin-bottom:6px">长江雨课堂 · 连续播放助手</div>' +
      '<div data-status style="margin-bottom:10px;overflow-wrap:anywhere" aria-live="polite"></div>' +
      '<button type="button" data-play>播放 / 继续</button> <button type="button" data-toggle></button>' +
      '<div style="margin-top:9px"><label>倍速 <select data-speed aria-label="播放倍速" style="padding:3px;color:#172033;background:#fff">' +
      SPEEDS.map(rate => `<option value="${rate}">${rate}×</option>`).join('') + '</select></label> ' +
      '<label><input type="checkbox" data-speed-lock> 锁定倍速</label></div>' +
      '<div data-speed-status style="font-size:12px;color:#cbd5e1;margin-top:3px" aria-live="polite"></div>' +
      '<div style="margin-top:8px"><button type="button" data-pick>指定下一节按钮</button></div>' +
      '<div style="margin-top:9px"><label><input type="checkbox" data-next> 视频结束后自动下一节</label></div>' +
      '<button type="button" data-clear style="margin-top:8px">清除指定</button>';
    for (const button of panel.querySelectorAll('button')) {
      button.style.cssText += 'cursor:pointer;font:12px sans-serif;padding:5px 7px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#172033;';
    }
    statusNode = panel.querySelector('[data-status]');
    statusNode.textContent = status;
    toggleButton = panel.querySelector('[data-toggle]');
    toggleButton.textContent = config.enabled ? '停止辅助' : '启用辅助';
    speedSelect = panel.querySelector('[data-speed]');
    speedSelect.value = String(config.playbackRate);
    speedLockCheckbox = panel.querySelector('[data-speed-lock]');
    speedLockCheckbox.checked = config.lockRate;
    speedStatusNode = panel.querySelector('[data-speed-status]');
    speedSelect.addEventListener('change', () => {
      const rate = Number(speedSelect.value);
      if (!SPEEDS.includes(rate)) return;
      config.playbackRate = rate;
      config.lockRate = true;
      speedLockCheckbox.checked = true;
      save();
      applyPlaybackRate(video, true);
    });
    speedLockCheckbox.addEventListener('change', () => {
      config.lockRate = speedLockCheckbox.checked;
      rateError = '';
      save();
      applyPlaybackRate(video);
    });
    updateSpeedStatus();
    panel.querySelector('[data-play]').addEventListener('click', () => {
      config.enabled = true;
      setPending(true);
      save();
      if (video?.ended) scheduleNext();
      else if (video) requestPlay(video);
      else restoreStatus();
      updateButton();
    });
    toggleButton.addEventListener('click', () => {
      if (config.enabled) {
        config.enabled = false;
        clearNext();
        setPending(false);
        video?.pause();
        setStatus('辅助已停止');
      } else {
        config.enabled = true;
        setPending(true);
        if (video?.ended) scheduleNext();
        else if (video) requestPlay(video);
        else restoreStatus();
      }
      save();
      updateButton();
    });
    panel.querySelector('[data-pick]').addEventListener('click', () => {
      selecting = true;
      clearNext();
      document.documentElement.style.cursor = 'crosshair';
      setStatus('请点击页面上的“下一节”按钮；此次只记住位置。Esc 取消');
    });
    nextCheckbox = panel.querySelector('[data-next]');
    nextCheckbox.checked = config.autoNext;
    nextCheckbox.addEventListener('change', () => {
      config.autoNext = nextCheckbox.checked;
      save();
      if (config.autoNext && video?.ended) scheduleNext();
      else { clearNext(); restoreStatus(); }
    });
    panel.querySelector('[data-clear]').addEventListener('click', () => {
      config.nextSelector = '';
      config.nextText = '';
      config.nextTag = '';
      save();
      setStatus('已恢复自动识别下一节按钮');
      if (video?.ended) scheduleNext();
    });
    document.body.appendChild(panel);
  }
  function updateButton() {
    if (toggleButton) toggleButton.textContent = config.enabled ? '停止辅助' : '启用辅助';
    updateSpeedStatus();
  }
  function scan() {
    scanTimer = 0;
    createPanel();
    if (lastURL !== location.href) {
      lastURL = location.href;
      clearNext();
    }
    const candidates = [...document.querySelectorAll('video')].filter(visible);
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });
    const best = candidates[0] || null;
    if (best !== video) bindVideo(best);
    else applyPlaybackRate(video);
    updateButton();
  }
  const observer = new MutationObserver(() => {
    if (!scanTimer) scanTimer = setTimeout(scan, 150);
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  document.addEventListener('DOMContentLoaded', scan, { once: true });
  // 低频处理 SPA 路由与播放器的替换，避免依赖特定框架。
  setInterval(scan, 2000);
  scan();
})();
