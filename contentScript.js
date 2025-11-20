const OVERLAY_ID = 'rm-reader-overlay';
const STORAGE_KEYS = [
  'readerTheme',
  'readerFontSize',
  'readerLineHeight',
  'readerMaxWidth',
  'readerTextAlign',
  'readerFontFamily'
];
const THEME_CLASSES = ['rm-theme-white', 'rm-theme-beige', 'rm-theme-gray', 'rm-theme-black'];
const FONT_FALLBACK_LATIN = '"Georgia", "Times New Roman", serif';
const FONT_FALLBACK_CJK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "WenQuanYi Micro Hei", sans-serif';
const FONT_FALLBACK = FONT_FALLBACK_LATIN;
const VALID_THEMES = new Set(['white', 'beige', 'gray', 'black']);

let currentState = {
  active: false,
  theme: 'white',
  fontSize: 20,
  lineHeight: 1.7,
  maxWidth: 900,
  textAlign: 'justify',
  fontFamily: FONT_FALLBACK
};

// Load last-used preferences from local storage (per device)
chrome.storage.local.get(STORAGE_KEYS, (stored) => {
  if (stored.readerTheme && VALID_THEMES.has(stored.readerTheme)) {
    currentState.theme = stored.readerTheme;
  }
  if (stored.readerFontSize) currentState.fontSize = stored.readerFontSize;
  if (stored.readerLineHeight) currentState.lineHeight = stored.readerLineHeight;
  if (stored.readerMaxWidth) currentState.maxWidth = stored.readerMaxWidth;
  if (stored.readerTextAlign) currentState.textAlign = stored.readerTextAlign;
  if (stored.readerFontFamily) currentState.fontFamily = stored.readerFontFamily;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TOGGLE_READER_ACTION') {
    toggleReader(currentState.theme, currentState.fontSize);
    sendResponse?.({ status: 'ok' });
    return true;
  }
  if (request.type === 'SET_READER_PREFS') {
    if (request.theme) currentState.theme = request.theme;
    if (request.fontSize) currentState.fontSize = request.fontSize;
    chrome.storage.local.set({ readerTheme: currentState.theme, readerFontSize: currentState.fontSize });
    return true;
  }
  return false;
});

function toggleReader(theme, fontSize) {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    if (typeof existing._cleanup === 'function') existing._cleanup();
    existing.remove();
    currentState.active = false;
    return;
  }

  const article = getArticleForReader();
  if (!article) {
    console.warn('Zen Reader: no primary article content found on this page.');
    return;
  }

  const overlay = buildOverlay({
    theme,
    fontSize,
    title: article.title,
    metadata: article.metadata,
    contentNode: article.contentNode,
    language: article.language
  });

  document.body.appendChild(overlay);
  currentState.active = true;
  currentState.theme = theme;
  currentState.fontSize = fontSize;
  persistState();
}

function scoreElement(el) {
  // Basic heuristic: text length minus link penalty to favor dense article text
  const text = el.innerText || '';
  const linkText = Array.from(el.querySelectorAll('a')).map((a) => a.innerText || '').join(' ');
  const score = text.replace(/\s+/g, '').length - linkText.replace(/\s+/g, '').length * 0.5;
  return score;
}

const SKIP_PATTERNS =
  /(related|recommend|trending|comment|promo|ad(vert)?|footer|sidebar|sponsored|nav|more-articles|more-stories|newsletter)/i;

const ALLOWED_VIDEO_REGEX =
  (typeof Readability === 'function' && Readability.prototype?.REGEXPS?.videos) ||
  /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq|bilibili|live\.bilibili)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv|brightcove\.com)/i;

function isUnwanted(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const val = `${node.className || ''} ${node.id || ''} ${node.getAttribute('role') || ''}`.toLowerCase();
  return SKIP_PATTERNS.test(val);
}

function getNodeTextLength(node) {
  if (!node) return 0;
  return (node.innerText || node.textContent || '').replace(/\s+/g, '').length;
}

function getArticleForReader() {
  const readabilityArticle = extractWithReadability();
  if (readabilityArticle) return readabilityArticle;

  const main = extractMainCandidate();

  if (main) {
    const cleaned = cleanupNode(main.cloneNode(true));
    const textLength = getNodeTextLength(cleaned);
    if (textLength > 300) {
      return {
        contentNode: cleaned,
        title: getTitle(),
        metadata: getMetadata(main),
        language: detectLanguage(cleaned)
      };
    }
  }

  if (main) {
    const cleaned = cleanupNode(main.cloneNode(true));
    const textLength = getNodeTextLength(cleaned);
    if (textLength > 80) {
      return {
        contentNode: cleaned,
        title: getTitle(),
        metadata: getMetadata(main),
        language: detectLanguage(cleaned)
      };
    }
  }

  const fallback = buildParagraphFallback();
  if (fallback) {
    const cleaned = cleanupNode(fallback);
    const language = detectLanguage(cleaned);
    return {
      contentNode: cleaned,
      title: getTitle(),
      metadata: getMetadata(document),
      language
    };
  }

  return null;
}

function extractMainCandidate() {
  const selectorCandidates = Array.from(
    document.querySelectorAll(
      'article, main, [role="main"], .article, .article-body, .post, .post-content, .entry-content, .content'
    )
  ).filter((el) => !isUnwanted(el));

  const paragraphParents = Array.from(document.querySelectorAll('p'))
    .filter((p) => (p.innerText || '').trim().length > 60 && !isUnwanted(p))
    .map((p) => p.closest('article, section, div') || p.parentElement)
    .filter(Boolean);

  const allCandidates = Array.from(new Set([...selectorCandidates, ...paragraphParents]));

  const scored = allCandidates
    .map((el) => ({ el, score: scoreElement(el) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) return scored[0].el;
  return null;
}

function prepareDocumentForReadability() {
  const html = document.documentElement.outerHTML;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.documentElement;

  hydrateLazyText(root);
  unwrapNoscriptImages(root);
  hydrateMediaSources(root);
  fixLazyImages(root);

  return doc;
}

function extractWithReadability() {
  if (typeof Readability !== 'function') return null;
  try {
    const doc = prepareDocumentForReadability();
    const location = document.location;
    const reader = new Readability(doc, {
      debug: false,
      uri: location,
      allowedVideoRegex: ALLOWED_VIDEO_REGEX,
      charThreshold: 200
    });
    const article = reader.parse();
    if (!article || !article.content) return null;

    const container = document.createElement('div');
    container.innerHTML = article.content;
    const cleaned = cleanupNode(container);
    const textLength = getNodeTextLength(cleaned);
    if (textLength < 120) return null;

    return {
      contentNode: cleaned,
      title: getTitle(article.title || ''),
      metadata:
        getMetadata(document, {
          byline: article.byline,
          published: article.publishedTime || article.published,
          siteName: article.siteName
        }) ||
        { author: article.byline || '', published: '' },
      language: article.lang || detectLanguage(cleaned)
    };
  } catch (err) {
    console.warn('Zen Reader: Readability fallback failed', err);
    return null;
  }
}

function buildParagraphFallback() {
  const fallback = document.createElement('article');
  fallback.className = 'rm-reader-fallback';
  let added = 0;

  const selectors = ['p', 'h1', 'h2', 'h3', 'blockquote', 'li', 'figure', 'img', 'picture', 'table'];

  Array.from(document.querySelectorAll(selectors.join(','))).forEach((node) => {
    if (isUnwanted(node) || node.closest('nav, header, footer, aside, form')) return;
    if (node.tagName !== 'TABLE' && node.closest('table')) return;
    const text = (node.innerText || node.textContent || '').trim();
    if (node.tagName === 'P' && text.length < 30) return;
    const clone = node.cloneNode(true);
    hydrateLazyText(clone);
    fallback.appendChild(clone);
    added++;
  });

  if (added > 3) return fallback;
  return null;
}

// Populate nodes that defer text or HTML into data-* attributes or <template/> blocks
function hydrateLazyText(root) {
  if (!root) return;
  const doc = root.ownerDocument || document;

  const textAttrs = [
    'data-text',
    'data-content',
    'data-body',
    'data-article-body',
    'data-description',
    'data-copy',
    'data-message'
  ];
  const htmlAttrs = ['data-lazy-html', 'data-html', 'data-body-html', 'data-raw-html'];

  const textSelector = textAttrs.map((attr) => `[${attr}]`).join(',');
  if (textSelector) {
    root.querySelectorAll(textSelector).forEach((el) => {
      if ((el.textContent || '').trim()) return;
      for (const attr of textAttrs) {
        const val = el.getAttribute(attr);
        if (val && val.trim()) {
          el.textContent = val.trim();
          break;
        }
      }
    });
  }

  const htmlSelector = htmlAttrs.map((attr) => `[${attr}]`).join(',');
  if (htmlSelector) {
    root.querySelectorAll(htmlSelector).forEach((el) => {
      if ((el.innerHTML || '').trim()) return;
      for (const attr of htmlAttrs) {
        const val = el.getAttribute(attr);
        if (val && /<.+>/.test(val)) {
          const frag =
            doc.createRange && doc.createRange().createContextualFragment
              ? doc.createRange().createContextualFragment(val)
              : null;
          if (frag) {
            el.appendChild(frag);
          } else {
            el.innerHTML = val;
          }
          break;
        }
      }
    });
  }

  root.querySelectorAll('template').forEach((tpl) => {
    if (tpl.dataset?.rmHydrated === '1') return;
    const content = tpl.content ? tpl.content.cloneNode(true) : null;
    const text = content ? (content.textContent || '').trim() : (tpl.textContent || '').trim();
    if (!text || text.length < 80) return;
    const parent = tpl.parentNode;
    if (!parent) return;
    if (parent.childNodes.length > 1 && (parent.textContent || '').trim().length > 40) return;
    if (content) {
      parent.appendChild(content);
    } else {
      const wrapper = doc.createElement('div');
      wrapper.innerHTML = tpl.innerHTML;
      while (wrapper.firstChild) parent.appendChild(wrapper.firstChild);
    }
    tpl.dataset.rmHydrated = '1';
  });
}

// Parse <noscript> wrappers that contain real images/pictures and inject them back into the live DOM
function unwrapNoscriptImages(root) {
  root.querySelectorAll('noscript').forEach((ns) => {
    const html = ns.textContent || ns.innerHTML || '';
    if (!/<img|<picture/i.test(html)) return;
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const replacement = doc.querySelector('img, picture');
    if (!replacement) return;
    const parent = ns.parentElement;
    if (!parent) return;
    const clone = replacement.cloneNode(true);
    if (parent.matches('figure') && !parent.querySelector('img, picture')) {
      parent.insertBefore(clone, ns);
      ns.remove();
      return;
    }
    if (!parent.querySelector('img, picture')) {
      parent.insertBefore(clone, ns);
    }
  });
}

// Try to hydrate lazy-loaded media using data-* attributes from the source page
function hydrateMediaSources(root) {
  const doc = root.ownerDocument || document;
  const placeholderRe = /(transparent|spacer\.gif|1x1)/i;
  const srcAttrs = [
    'data-src',
    'data-original',
    'data-url',
    'data-image',
    'data-lazy',
    'data-lazy-src',
    'data-async-src',
    'data-href',
    'data-src-large',
    'data-src-medium',
    'data-src-small'
  ];
  const srcsetAttrs = ['data-srcset', 'data-srcset-large', 'data-srcset-medium', 'data-srcset-small', 'data-original-set', 'data-lazy-srcset'];
  const posterAttrs = ['data-poster', 'data-thumb', 'data-thumbnail', 'data-preview'];

  const setIfNeeded = (el, attr, val) => {
    if (!val) return;
    const current = el.getAttribute(attr);
    if (current && !placeholderRe.test(current)) return;
    el.setAttribute(attr, val);
  };

  root.querySelectorAll('img, source, video').forEach((el) => {
    srcAttrs.forEach((name) => setIfNeeded(el, 'src', el.getAttribute(name)));
    srcsetAttrs.forEach((name) => setIfNeeded(el, 'srcset', el.getAttribute(name)));
  });

  root.querySelectorAll('video').forEach((video) => {
    posterAttrs.forEach((name) => setIfNeeded(video, 'poster', video.getAttribute(name)));
    if (!video.getAttribute('preload')) video.setAttribute('preload', 'metadata');
  });

  root.querySelectorAll('figure').forEach((fig) => {
    if (fig.querySelector('img')) return;
    const src = fig.getAttribute('data-src');
    const srcset = fig.getAttribute('data-srcset');
    if (!src && !srcset) return;
    const img = doc.createElement('img');
    if (src) img.setAttribute('src', src);
    if (srcset) img.setAttribute('srcset', srcset);
    fig.appendChild(img);
  });
}

// Port of Readability's lazy-image fixer to pull real src/srcset values through
function fixLazyImages(root) {
  const doc = root.ownerDocument || document;
  const b64Re = /data:image\/(\w+);base64,/;
  const srcsetUrl = /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g;
  const srcsetCandidate = /\.(jpe?g|png|webp|gif|avif|bmp)/i;

  root.querySelectorAll('img, picture, figure, source').forEach((elem) => {
    if (elem.src && b64Re.test(elem.src)) {
      const parts = b64Re.exec(elem.src);
      if (parts && parts[1] !== 'svg+xml') {
        let hasAlternate = false;
        for (const attr of elem.attributes) {
          if (attr.name === 'src') continue;
          if (/\.(jpe?g|png|webp|gif|avif|bmp)/i.test(attr.value)) {
            hasAlternate = true;
            break;
          }
        }
        if (hasAlternate) elem.removeAttribute('src');
      }
    }

    if ((elem.src || (elem.getAttribute && elem.getAttribute('srcset') && elem.getAttribute('srcset') !== 'null')) && !/lazy/i.test(elem.className || '')) {
      return;
    }

    for (const attr of elem.attributes || []) {
      if (attr.name === 'src' || attr.name === 'srcset' || attr.name === 'alt') continue;
      let copyTo = null;
      if (srcsetCandidate.test(attr.value)) {
        if (/\.(jpe?g|png|webp|gif|avif|bmp)\s+\d/.test(attr.value)) {
          copyTo = 'srcset';
        } else if (/^\s*\S+\.(jpe?g|png|webp|gif|avif|bmp)\S*\s*$/.test(attr.value)) {
          copyTo = 'src';
        }
      }
      if (copyTo) {
        if (elem.tagName === 'IMG' || elem.tagName === 'PICTURE' || elem.tagName === 'SOURCE') {
          elem.setAttribute(copyTo, attr.value);
        } else if (elem.tagName === 'FIGURE' && !elem.querySelector('img, picture')) {
          const img = doc.createElement('img');
          img.setAttribute(copyTo, attr.value);
          elem.appendChild(img);
        }
      }
    }

    const srcset = elem.getAttribute && elem.getAttribute('srcset');
    if (elem.tagName === 'IMG' && !elem.getAttribute('src') && srcset) {
      const first = srcset.replace(srcsetUrl, '$1').split(',')[0].trim();
      if (first) elem.setAttribute('src', first);
    }
  });
}

// Group content under headings into sections for clearer separation
function wrapSections(contentNode) {
  const doc = contentNode.ownerDocument || document;
  const children = Array.from(contentNode.childNodes);
  while (contentNode.firstChild) contentNode.removeChild(contentNode.firstChild);
  let currentSection = null;

  const startSection = () => {
    currentSection = doc.createElement('div');
    currentSection.className = 'rm-section';
    contentNode.appendChild(currentSection);
  };

  children.forEach((node) => {
    const isHeading = node.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/.test(node.tagName);
    if (isHeading || !currentSection) startSection();
    currentSection.appendChild(node);
  });
}

function removeDuplicateTitle(contentNode, title) {
  if (!contentNode || !title) return;
  const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return;

  const firstHeading = contentNode.querySelector('h1, h2');
  if (!firstHeading) return;
  const headingText = normalize(firstHeading.innerText || firstHeading.textContent || '');
  if (!headingText) return;

  const exactMatch = headingText === normalizedTitle;
  const partialMatch = normalizedTitle.startsWith(headingText) || headingText.startsWith(normalizedTitle);
  if (exactMatch || partialMatch) {
    firstHeading.remove();
  }
}

function isAllowedVideoNode(el) {
  if (!el) return false;
  if (el.tagName === 'VIDEO') {
    const hasSource = el.getAttribute('src') || el.querySelector('source');
    return Boolean(hasSource);
  }
  const src = (el.getAttribute('src') || el.getAttribute('data-src') || '').trim();
  if (src && ALLOWED_VIDEO_REGEX.test(src)) return true;
  const source = el.querySelector?.('source[src], source[data-src], source[data-srcset]');
  if (source) {
    const sourceSrc = source.getAttribute('src') || source.getAttribute('data-src') || source.getAttribute('data-srcset') || '';
    if (sourceSrc && ALLOWED_VIDEO_REGEX.test(sourceSrc)) return true;
  }
  return false;
}

function cleanupNode(root) {
  const container = document.createElement('div');
  container.className = 'rm-reader-article';

  hydrateLazyText(root);
  unwrapNoscriptImages(root);
  hydrateMediaSources(root);
  fixLazyImages(root);

  // Remove non-essential or potentially intrusive elements
  root
    .querySelectorAll(
      'script, style, noscript, form, button, input, select, textarea, nav, aside, [role="navigation"], [role="banner"], [role="complementary"], .advert, .ads, .social, .sidebar, .comment, .comments'
    )
    .forEach((el) => el.remove());

  root.querySelectorAll('iframe, object, embed').forEach((el) => {
    if (!isAllowedVideoNode(el)) el.remove();
  });

  // Strip inline event handlers to avoid executing page JS
  root.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
      if (attr.name === 'style') el.removeAttribute('style');
    });
  });

  // Only keep paragraphs, headings, lists, blockquotes, images, and plain text
  const allowed = new Set([
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'A',
    'UL',
    'OL',
    'LI',
    'BLOCKQUOTE',
    'B',
    'I',
    'EM',
    'SPAN',
    'STRONG',
    'IMG',
    '#text',
    'FIGURE',
    'FIGCAPTION',
    'PICTURE',
    'SOURCE',
    'VIDEO',
    'IFRAME',
    'TABLE',
    'THEAD',
    'TBODY',
    'TFOOT',
    'TR',
    'TD',
    'TH',
    'CAPTION',
    'COLGROUP',
    'COL'
  ]);
  const allowEmpty = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL', 'SOURCE', 'VIDEO', 'IFRAME']);

  function appendClean(node, target) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) target.appendChild(document.createTextNode(text + ' '));
      return;
    }

    if (isUnwanted(node)) return;

    if (!allowed.has(node.nodeName)) {
      node.childNodes.forEach((child) => appendClean(child, target));
      return;
    }

    const clone = node.cloneNode(false);
    if (clone.nodeName === 'IMG') {
      // Constrain very large images later via CSS; skip transparent pixels
      const src = clone.getAttribute('src');
      if (!src) return;
      clone.removeAttribute('style');
    }
    if (clone.nodeName === 'IFRAME' || clone.nodeName === 'OBJECT' || clone.nodeName === 'EMBED') {
      if (!isAllowedVideoNode(node)) return;
      if (!clone.getAttribute('src')) {
        const dataSrc = node.getAttribute('data-src') || node.getAttribute('data-url');
        if (dataSrc) clone.setAttribute('src', dataSrc);
      }
      clone.setAttribute('loading', 'lazy');
      clone.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    }
    if (clone.nodeName === 'VIDEO') {
      clone.setAttribute('controls', 'controls');
      if (!clone.hasAttribute('preload')) clone.setAttribute('preload', 'metadata');
    }

    node.childNodes.forEach((child) => appendClean(child, clone));
    if (clone.childNodes.length === 0 && clone.nodeName !== 'IMG' && !allowEmpty.has(clone.nodeName)) return;
    target.appendChild(clone);
  }

  root.childNodes.forEach((child) => appendClean(child, container));
  return container;
}

function getTitle(fallback = '') {
  const candidates = [];

  const metaSelectors = [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="title"]',
    'meta[itemprop="headline"]'
  ];

  if (fallback) candidates.push(fallback.trim());

  metaSelectors.forEach((sel) => {
    const el = document.querySelector(sel);
    const val = el?.getAttribute('content');
    if (val) candidates.push(val.trim());
  });

  if (document.title) candidates.push(document.title.trim());

  const cleaned = candidates
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t, idx, arr) => arr.indexOf(t) === idx);

  const preferred = cleaned.find((t) => t.length > 10) || cleaned[0];
  return preferred || 'Zen Reader';
}

function getMetadata(mainContent, hints = {}) {
  const hintByline = hints.byline && hints.byline.trim ? hints.byline.trim() : '';
  const hintPublished = hints.published || hints.publishedTime || '';
  const hintAuthorUrl = hints.authorUrl || '';
  const hintSiteName = hints.siteName || '';
  const findText = (selector) => {
    const el = mainContent.querySelector(selector) || document.querySelector(selector);
    return el ? el.textContent.trim() : '';
  };

  const authorElement =
    mainContent.querySelector('[rel="author"]') ||
    mainContent.querySelector('.author, .byline, .post-author') ||
    document.querySelector('[rel="author"], .author, .byline, .post-author');

  const authorMeta = document.querySelector('meta[name="author"]');
  const authorLinkEl = authorElement?.closest('a') || (authorElement?.tagName === 'A' ? authorElement : authorElement?.querySelector?.('a'));
  const author =
    hintByline ||
    authorElement?.textContent.trim() ||
    authorMeta?.getAttribute('content') ||
    findText('meta[name="author"]');
  const authorUrl = hintAuthorUrl || authorLinkEl?.href || '';

  const dateElement =
    mainContent.querySelector('time[datetime], time, [itemprop="datePublished"]') ||
    document.querySelector('time[datetime], time, [itemprop="datePublished"]');

  const dateAttr =
    document.querySelector(
      'meta[property="article:published_time"], meta[name="pubdate"], meta[name="date"], meta[itemprop="datePublished"]'
    ) || dateElement;

  const dateText = dateAttr?.getAttribute('content') || dateAttr?.getAttribute('datetime') || dateAttr?.textContent;
  const published = hintPublished ? formatDate(hintPublished) : dateText ? formatDate(dateText) : '';

  const removeLine = (el) => {
    if (!el || !mainContent || mainContent.nodeType === Node.DOCUMENT_NODE) return;
    if (!mainContent.contains(el)) return;
    const container = el.closest('p, div, span, header, footer, section') || el;
    if (/\bby\b/i.test((container.textContent || '').trim())) {
      container.remove();
      return;
    }
    el.remove();
  };

  removeLine(authorElement);
  removeLine(dateElement);

  return { author, authorUrl, published, siteName: hintSiteName };
}

function formatDate(raw) {
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }
  return raw.trim();
}

function buildOverlay({ theme, fontSize, title, metadata, contentNode, language }) {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = `rm-reader-overlay rm-theme-${theme} rm-images-on`;
  overlay.dataset.lang = language;
  ensureFontForLanguage(language);
  applyStateToOverlay(overlay);

  const inner = document.createElement('div');
  inner.className = 'rm-reader-shell';

  const header = document.createElement('div');
  header.className = 'rm-reader-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'rm-reader-title';
  titleEl.textContent = title;

  const metaEl = document.createElement('div');
  metaEl.className = 'rm-reader-meta';
  const metaNodes = [];
  const addPart = (node) => {
    if (metaNodes.length) metaNodes.push(document.createTextNode(' • '));
    metaNodes.push(node);
  };
  if (metadata?.author) {
    if (metadata?.authorUrl) {
      const a = document.createElement('a');
      a.href = metadata.authorUrl;
      a.textContent = metadata.author;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      addPart(a);
    } else {
      addPart(document.createTextNode(metadata.author));
    }
  }
  if (metadata?.published) addPart(document.createTextNode(metadata.published));
  metaNodes.forEach((n) => metaEl.appendChild(n));

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rm-close';
  closeBtn.setAttribute('aria-label', 'Close Zen Reader');
  closeBtn.title = 'Close Zen Reader';
  const closeIcon = document.createElement('span');
  closeIcon.className = 'rm-close-icon';
  closeIcon.setAttribute('aria-hidden', 'true');
  closeIcon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="5.63605" y="4.2218" width="20" height="3" rx="1.5" transform="rotate(45 5.63605 4.2218)" fill="currentColor"/>
<rect x="4.2218" y="18.364" width="20" height="3" rx="1.5" transform="rotate(-45 4.2218 18.364)" fill="currentColor"/>
</svg>`;
  closeBtn.appendChild(closeIcon);
  closeBtn.addEventListener('click', () => {
    overlay._cleanup?.();
    overlay.remove();
    currentState.active = false;
  });

  const styleUI = buildStylePanel(overlay, language);

  const returnTopBtn = document.createElement('button');
  returnTopBtn.type = 'button';
  returnTopBtn.className = 'rm-move-top';
  returnTopBtn.textContent = 'Return to top';
  returnTopBtn.title = 'Scroll back to top';
  returnTopBtn.addEventListener('click', () => {
    overlay.scrollTo({ top: 0, behavior: 'smooth' });
  });

  header.append(titleEl, metaEl);

  removeDuplicateTitle(contentNode, title);
  wrapSections(contentNode);

  const body = document.createElement('div');
  body.className = 'rm-reader-body';
  body.appendChild(contentNode);

  inner.append(header, body);
  const outlineUI = buildOutlinePanel(overlay, body);

  const imagesToggle = document.createElement('button');
  imagesToggle.type = 'button';
  imagesToggle.className = 'rm-images-toggle';
  imagesToggle.title = 'Toggle images';
  const setImagesState = (show) => {
    overlay.classList.toggle('rm-images-on', show);
    overlay.classList.toggle('rm-images-off', !show);
    imagesToggle.textContent = show ? 'Hide images' : 'Show images';
    imagesToggle.setAttribute('aria-pressed', String(show));
  };
  setImagesState(true);
  imagesToggle.addEventListener('click', () => {
    const next = !overlay.classList.contains('rm-images-on');
    setImagesState(next);
  });

  const linksToggle = document.createElement('button');
  linksToggle.type = 'button';
  linksToggle.className = 'rm-links-toggle';
  linksToggle.textContent = 'Show links';
  linksToggle.title = 'Toggle link highlighting';
  linksToggle.addEventListener('click', () => {
    const active = overlay.classList.toggle('rm-links-on');
    linksToggle.textContent = active ? 'Hide links' : 'Show links';
  });

  overlay.append(
    closeBtn,
    styleUI.toggleBtn,
    outlineUI.toggleBtn,
    imagesToggle,
    linksToggle,
    returnTopBtn,
    styleUI.panel,
    outlineUI.panel,
    inner
  );
  overlay._cleanup = () => {
    styleUI.cleanup();
    outlineUI.cleanup();
  };
  return overlay;
}

function setTheme(overlay, theme) {
  const next = VALID_THEMES.has(theme) ? theme : 'white';
  THEME_CLASSES.forEach((c) => overlay.classList.remove(c));
  overlay.classList.add(`rm-theme-${next}`);
  currentState.theme = next;
}

function ensureFontForLanguage(language) {
  const fallback = language === 'zh' ? FONT_FALLBACK_CJK : FONT_FALLBACK_LATIN;
  const isFallback = (value) => {
    return value === FONT_FALLBACK || value === FONT_FALLBACK_LATIN || value === FONT_FALLBACK_CJK;
  };

  if (!currentState.fontFamily || isFallback(currentState.fontFamily)) {
    currentState.fontFamily = fallback;
  }

  if (language === 'zh' && currentState.fontFamily === FONT_FALLBACK_LATIN) {
    currentState.fontFamily = fallback;
  }
  if (language !== 'zh' && currentState.fontFamily === FONT_FALLBACK_CJK) {
    currentState.fontFamily = fallback;
  }
}

function applyStateToOverlay(overlay) {
  const lang = overlay.dataset.lang || 'en';
  const fallback = lang === 'zh' ? FONT_FALLBACK_CJK : FONT_FALLBACK_LATIN;
  const fontFamily = currentState.fontFamily || fallback;
  overlay.style.setProperty('--rm-font-size', `${currentState.fontSize}px`);
  overlay.style.setProperty('--rm-line-height', currentState.lineHeight);
  overlay.style.setProperty('--rm-max-width', `${currentState.maxWidth}px`);
  overlay.style.setProperty('--rm-align', currentState.textAlign);
  overlay.style.setProperty('--rm-font-family', fontFamily);
  setTheme(overlay, currentState.theme);
}

function persistState() {
  chrome.storage.local.set({
    readerTheme: currentState.theme,
    readerFontSize: currentState.fontSize,
    readerLineHeight: currentState.lineHeight,
    readerMaxWidth: currentState.maxWidth,
    readerTextAlign: currentState.textAlign,
    readerFontFamily: currentState.fontFamily
  });
}

function buildStylePanel(overlay, language) {
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'rm-style-toggle';
  toggleBtn.textContent = 'Style';
  toggleBtn.title = 'Toggle style panel';

  const panel = document.createElement('div');
  panel.className = 'rm-style-panel';

  const section = (title) => {
    const wrap = document.createElement('div');
    wrap.className = 'rm-style-section';
    const label = document.createElement('div');
    label.className = 'rm-style-label';
    label.textContent = title;
    wrap.appendChild(label);
    return { wrap, label };
  };

  // Theme selector
  const themeSec = section('Theme');
  const themeRow = document.createElement('div');
  themeRow.className = 'rm-theme-swatches';
  [
    { key: 'white', label: 'White' },
    { key: 'beige', label: 'Beige' },
    { key: 'gray', label: 'Gray' },
    { key: 'black', label: 'Black' }
  ].forEach((theme) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `rm-swatch ${currentState.theme === theme.key ? 'active' : ''}`;
    btn.dataset.theme = theme.key;
    btn.title = theme.label;
    btn.addEventListener('click', () => {
      currentState.theme = theme.key;
      updateSwatchActive(themeRow, theme.key);
      applyStateToOverlay(overlay);
      persistState();
    });
    themeRow.appendChild(btn);
  });
  themeSec.wrap.appendChild(themeRow);
  panel.appendChild(themeSec.wrap);

  // Font family selector
  const fontSec = section('Font');
  const fontList = document.createElement('div');
  fontList.className = 'rm-font-list';
  const fonts = getFontsForLanguage(language);
  const fontFallback = overlay.dataset.lang === 'zh' ? FONT_FALLBACK_CJK : FONT_FALLBACK_LATIN;
  let initialActiveFont = null;
  const resolveFontFamily = (name, customFallback) => {
    const trimmed = (name || '').trim();
    const fallbackStack = (customFallback || fontFallback || '').trim();
    if (!trimmed && !fallbackStack) return '';
    if (!trimmed) return fallbackStack;
    const suffix = fallbackStack ? `, ${fallbackStack}` : '';
    if (trimmed.startsWith('-')) return `${trimmed}${suffix}`;
    if (/\s/.test(trimmed)) return `"${trimmed}"${suffix}`;
    return `${trimmed}${suffix}`;
  };

  fonts.forEach((font) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = font.label;
    btn.className = 'rm-font-choice';
    btn.dataset.fontValue = font.value;
    const fontFamily = resolveFontFamily(font.value, font.fallback);
    btn.style.fontFamily = fontFamily;
    if (!initialActiveFont && currentState.fontFamily && currentState.fontFamily.includes(font.value)) {
      initialActiveFont = font.value;
    }
    btn.addEventListener('click', () => {
      currentState.fontFamily = fontFamily;
      updateFontActive(fontList, font.value);
      applyStateToOverlay(overlay);
      persistState();
    });
    fontList.appendChild(btn);
  });
  if (initialActiveFont) updateFontActive(fontList, initialActiveFont);
  fontSec.wrap.appendChild(fontList);
  panel.appendChild(fontSec.wrap);

  // Stepper helper for numeric controls
  const addStepper = (labelText, value, step, min, max, format, onChange) => {
    const wrap = document.createElement('div');
    wrap.className = 'rm-stepper';

    const label = document.createElement('div');
    label.className = 'rm-stepper-label';
    label.textContent = labelText;

    const controls = document.createElement('div');
    controls.className = 'rm-stepper-controls';

    const valSpan = document.createElement('span');
    valSpan.className = 'rm-stepper-value';
    valSpan.textContent = format(value);

    const button = (text, delta) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rm-stepper-btn';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        const next = Math.min(max, Math.max(min, parseFloat((value + delta).toFixed(3))));
        if (next === value) return;
        value = next;
        valSpan.textContent = format(value);
        onChange(value);
      });
      return btn;
    };

    controls.append(button('−', -step), valSpan, button('+', step));
    wrap.append(label, controls);
    return wrap;
  };

  panel.appendChild(
    addStepper(
      'Font size',
      currentState.fontSize,
      1,
      14,
      30,
      (v) => `${v}px`,
      (v) => {
        currentState.fontSize = v;
        applyStateToOverlay(overlay);
        persistState();
      }
    )
  );

  panel.appendChild(
    addStepper(
      'Line height',
      currentState.lineHeight,
      0.05,
      1.2,
      2.4,
      (v) => v.toFixed(2),
      (v) => {
        currentState.lineHeight = v;
        applyStateToOverlay(overlay);
        persistState();
      }
    )
  );

  panel.appendChild(
    addStepper(
      'Max width',
      currentState.maxWidth,
      10,
      600,
      1100,
      (v) => `${Math.round(v)}px`,
      (v) => {
        currentState.maxWidth = v;
        applyStateToOverlay(overlay);
        persistState();
      }
    )
  );

  // Text alignment
  const alignSec = section('Alignment');
  const alignRow = document.createElement('div');
  alignRow.className = 'rm-align-row';
  ['justify', 'left', 'center'].forEach((align) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = align.charAt(0).toUpperCase() + align.slice(1);
    btn.className = `rm-align ${currentState.textAlign === align ? 'active' : ''}`;
    btn.addEventListener('click', () => {
      currentState.textAlign = align;
      updateAlignActive(alignRow, align);
      applyStateToOverlay(overlay);
      persistState();
    });
    alignRow.appendChild(btn);
  });
  alignSec.wrap.appendChild(alignRow);
  panel.appendChild(alignSec.wrap);

  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('open');
  });

  const outsideHandler = (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || toggleBtn.contains(e.target)) return;
    panel.classList.remove('open');
  };

  document.addEventListener('mousedown', outsideHandler, true);
  document.addEventListener('touchstart', outsideHandler, true);

  const cleanup = () => {
    document.removeEventListener('mousedown', outsideHandler, true);
    document.removeEventListener('touchstart', outsideHandler, true);
  };

  return { toggleBtn, panel, cleanup };
}

function updateSwatchActive(container, theme) {
  container.querySelectorAll('.rm-swatch').forEach((btn) => {
    if (btn.dataset.theme === theme) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function updateFontActive(container, fontValue) {
  container.querySelectorAll('.rm-font-choice').forEach((btn) => {
    if (btn.dataset.fontValue === fontValue) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function updateAlignActive(container, align) {
  container.querySelectorAll('.rm-align').forEach((btn) => {
    if (btn.textContent.toLowerCase() === align) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function buildOutlinePanel(overlay, contentRoot) {
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'rm-outline-toggle';
  toggleBtn.textContent = 'Show outline';
  toggleBtn.title = 'Toggle outline navigation';
  toggleBtn.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'rm-outline-panel';
  panel.setAttribute('role', 'navigation');

  const list = document.createElement('div');
  list.className = 'rm-outline-list';
  panel.appendChild(list);

  const buildOutline = () => {
    list.textContent = '';
    const headings = Array.from(contentRoot.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    if (!headings.length) {
      const empty = document.createElement('div');
      empty.className = 'rm-outline-empty';
      empty.textContent = 'No outline available';
      list.appendChild(empty);
      return;
    }

    headings.forEach((heading, idx) => {
      const level = Number(heading.tagName.charAt(1)) || 6;
      const rawText = (heading.innerText || heading.textContent || '').replace(/\s+/g, ' ').trim();
      const text = rawText || `Heading ${idx + 1}`;
      const condensed = text.length > 140 ? `${text.slice(0, 137)}...` : text;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `rm-outline-item level-${level}`;
      btn.textContent = condensed;
      btn.title = text;
      btn.addEventListener('click', () => {
        const rect = heading.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        const offset = rect.top - overlayRect.top - 12;
        const target = overlay.scrollTop + offset;
        if (typeof overlay.scrollTo === 'function') overlay.scrollTo({ top: target, behavior: 'smooth' });
        else overlay.scrollTop = target;
      });
      list.appendChild(btn);
    });
  };

  const setOpen = (open) => {
    panel.classList.toggle('open', open);
    toggleBtn.textContent = open ? 'Hide outline' : 'Show outline';
    toggleBtn.setAttribute('aria-expanded', String(open));
  };

  const outsideHandler = (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || toggleBtn.contains(e.target)) return;
    setOpen(false);
  };

  toggleBtn.addEventListener('click', () => {
    const next = !panel.classList.contains('open');
    if (next) buildOutline();
    setOpen(next);
  });

  document.addEventListener('mousedown', outsideHandler, true);
  document.addEventListener('touchstart', outsideHandler, true);

  const cleanup = () => {
    document.removeEventListener('mousedown', outsideHandler, true);
    document.removeEventListener('touchstart', outsideHandler, true);
  };

  return { toggleBtn, panel, rebuild: buildOutline, cleanup };
}

// Detect dominant language by counting Latin vs CJK characters in the cleaned content
function detectLanguage(root) {
  const text = (root.innerText || root.textContent || '').slice(0, 8000);
  let latin = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // Basic Latin and Latin-1 Supplement ranges
    if ((code >= 0x0041 && code <= 0x024f) || (code >= 0x1e00 && code <= 0x1eff)) {
      latin++;
    }
    // CJK Unified Ideographs + common punctuation
    if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    }
  }
  if (cjk > latin) return 'zh';
  return 'en';
}

function getFontsForLanguage(lang) {
  if (lang === 'zh') {
    return [
      { label: '苹方', value: 'PingFang SC' },
      { label: '宋体', value: 'Songti SC' },
      { label: '楷体', value: 'Kaiti SC' },
      { label: '圆体', value: 'Yuanti SC' }
    ];
  }
  return [
    { label: 'Athelas', value: 'Athelas' },
    { label: 'Charter', value: 'Charter' },
    { label: 'Georgia', value: 'Georgia' },
    { label: 'Iowan', value: 'Iowan Old Style' },
    { label: 'New York', value: 'New York' },
    { label: 'Palatino', value: 'Palatino' },
    {
      label: 'San Francisco',
      value: 'SF Pro Text',
      fallback: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    },
    { label: 'Seravek', value: 'Seravek', fallback: 'BlinkMacSystemFont, "Segoe UI", sans-serif' },
    { label: 'Times New Roman', value: 'Times New Roman' }
  ];
}
