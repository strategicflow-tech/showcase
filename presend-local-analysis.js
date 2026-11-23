'use strict';

(function exposeAnalyzer(root, factory) {
  const analyzer = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = analyzer;
  if (root) root.StrategicFlowPreSendAnalyzer = analyzer;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAnalyzer() {
  const CTA_VERBS = /\b(?:open|view|visit|start|try|get|download|book|reply|watch|shop|upgrade|run|explore|join|sign\s*up|see|claim|register|access|submit|send|use|discover|choose|schedule|request|compare|build|find|review|create|continue|apply|learn|read|click|check)\b/i;
  const CTA_ACTIONS = /\b(?:open|view|visit|start|try|get|download|book|reply|watch|shop|upgrade|run|explore|join|sign\s*up|see|claim|register|access|submit|send|use|discover|choose|schedule|request|compare|build|find|review|create|continue|apply|learn|read|click|check)\b/gi;
  const PASSIVE_CTA = /\b(?:learn more|click here|read more|check it out)\b/gi;
  const SHORTENERS = new Set([
    'bit.ly', 't.co', 'tinyurl.com', 'ow.ly', 'lnkd.in', 'cutt.ly',
    'rebrand.ly', 'rb.gy', 'shorturl.at', 'is.gd', 'buff.ly', 'goo.gl',
  ]);
  const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
    'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'the', 'this', 'to', 'was',
    'we', 'were', 'will', 'with', 'you', 'your', 'i', 'me', 'my', 'us', 'they', 'their',
    'them', 'he', 'she', 'his', 'her', 'if', 'then', 'than', 'that', 'these', 'those',
    'not', 'no', 'can', 'could', 'would', 'should', 'do', 'does', 'did', 'done', 'just',
    'now', 'very', 'more', 'most', 'some', 'any', 'each', 'per', 'all', 'so', 'up',
  ]);

  function normalizeText(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }

  function stripTags(value) {
    return decodeEntities(String(value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/blockquote|\/section)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '));
  }

  function readAttribute(attributes, name) {
    const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(attributes || '').match(expression);
    if (!match) return null;
    return match[1] ?? match[2] ?? match[3] ?? '';
  }

  function textFromMarkup(value) {
    return normalizeText(stripTags(value));
  }

  function parseContent(raw) {
    const isHtml = /<[a-z][\s\S]*>/i.test(raw);
    if (!isHtml) {
      const text = normalizeText(raw);
      const paragraphs = text.split(/\n\s*\n/).map(normalizeText).filter(Boolean);
      return {
        isHtml: false,
        text,
        paragraphs: paragraphs.length ? paragraphs : (text ? [text] : []),
        anchors: [],
        buttons: [],
        images: [],
        imageMarkupLength: 0,
      };
    }

    if (typeof DOMParser !== 'undefined') {
      const prepared = String(raw)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|h[1-6]|tr|td|blockquote|section)\s*>/gi, '\n\n');
      const doc = new DOMParser().parseFromString(prepared, 'text/html');
      doc.querySelectorAll('script,style,noscript').forEach(node => node.remove());
      const anchors = Array.from(doc.querySelectorAll('a')).map(node => ({
        href: node.getAttribute('href'),
        text: normalizeText(node.textContent),
        imageAlt: Array.from(node.querySelectorAll('img')).map(img => img.getAttribute('alt') || '').join(' ').trim(),
        source: 'anchor',
      }));
      const buttons = Array.from(doc.querySelectorAll('button,input[type="button"],input[type="submit"]')).map(node => ({
        text: normalizeText(node.textContent || node.getAttribute('value') || ''),
        source: 'button',
      }));
      const images = Array.from(doc.querySelectorAll('img')).map(node => {
        const style = node.getAttribute('style') || '';
        return {
          altPresent: node.hasAttribute('alt'),
          alt: node.getAttribute('alt') || '',
          hasDimensions: node.hasAttribute('width') || node.hasAttribute('height') || /\b(?:width|height)\s*:/i.test(style),
        };
      });
      const text = normalizeText(doc.body.textContent);
      const paragraphs = Array.from(doc.querySelectorAll('p'))
        .map(node => normalizeText(node.textContent))
        .filter(Boolean);
      const imageMarkupLength = Array.from(String(raw).matchAll(/<img\b[^>]*>/gi))
        .reduce((total, match) => total + match[0].length, 0);
      const fallbackParagraphs = text.split(/\n\s*\n/).map(normalizeText).filter(Boolean);
      return {
        isHtml: true,
        text,
        paragraphs: paragraphs.length ? paragraphs : (fallbackParagraphs.length ? fallbackParagraphs : (text ? [text] : [])),
        anchors,
        buttons,
        images,
        imageMarkupLength,
      };
    }

    const source = String(raw);
    const anchors = Array.from(source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)).map(match => ({
      href: readAttribute(match[1], 'href'),
      text: textFromMarkup(match[2]),
      imageAlt: Array.from(match[2].matchAll(/<img\b([^>]*)>/gi))
        .map(image => readAttribute(image[1], 'alt') || '')
        .join(' ')
        .trim(),
      source: 'anchor',
    }));
    const buttons = Array.from(source.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button\s*>/gi))
      .map(match => ({ text: textFromMarkup(match[1]), source: 'button' }));
    const images = Array.from(source.matchAll(/<img\b([^>]*)>/gi)).map(match => {
      const style = readAttribute(match[1], 'style') || '';
      return {
        altPresent: readAttribute(match[1], 'alt') !== null,
        alt: readAttribute(match[1], 'alt') || '',
        hasDimensions: readAttribute(match[1], 'width') !== null
          || readAttribute(match[1], 'height') !== null
          || /\b(?:width|height)\s*:/i.test(style),
      };
    });
    const text = normalizeText(stripTags(source));
    const paragraphs = text.split(/\n\s*\n/).map(normalizeText).filter(Boolean);
    return {
      isHtml: true,
      text,
      paragraphs: paragraphs.length ? paragraphs : (text ? [text] : []),
      anchors,
      buttons,
      images,
      imageMarkupLength: Array.from(source.matchAll(/<img\b[^>]*>/gi))
        .reduce((total, match) => total + match[0].length, 0),
    };
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  function clip(value, maxLength = 320) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trimEnd()}...`;
  }

  function evidence(text, match, maxLength = 320) {
    return { text: clip(text, maxLength), match: String(match || '').slice(0, 180) };
  }

  function countWords(text) {
    return (String(text || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
  }

  function sentenceRanges(text) {
    const value = String(text || '');
    const ranges = [];
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (!/[.!?]/.test(value[index])) continue;
      if (index + 1 < value.length && !/\s/.test(value[index + 1])) continue;
      const end = index + 1;
      const sentence = value.slice(start, end).trim();
      if (sentence) ranges.push({ text: sentence, start: value.indexOf(sentence, start) });
      start = end;
      while (start < value.length && /\s/.test(value[start])) start += 1;
    }
    const remainder = value.slice(start).trim();
    if (remainder) ranges.push({ text: remainder, start: value.indexOf(remainder, start) });
    return ranges;
  }

  function findOccurrences(text, expression) {
    const regex = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`);
    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
      if (!match[0].length) regex.lastIndex += 1;
    }
    return matches;
  }

  function sentenceFor(text, start, end) {
    const sentence = sentenceRanges(text).find(item => start >= item.start && start < item.start + item.text.length);
    if (sentence) return sentence.text;
    const from = Math.max(0, text.lastIndexOf('\n', start - 1) + 1);
    const nextLine = text.indexOf('\n', end);
    return text.slice(from, nextLine === -1 ? text.length : nextLine).trim() || text.slice(start, end);
  }

  function addSpans(target, matches) {
    for (const match of matches) target.push({ start: match.start, end: match.end });
  }

  function overlaps(position, spans) {
    return spans.some(span => position.start < span.end && position.end > span.start);
  }

  function factItems(text, matches) {
    const seen = new Set();
    return matches.map(match => {
      const sentence = sentenceFor(text, match.start, match.end);
      const key = `${match.value.toLowerCase()}::${sentence.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return { match: match.value, sentence };
    }).filter(Boolean);
  }

  function makeFactGroups(text) {
    const urlSpans = findOccurrences(text, /https?:\/\/[^\s<>"'`]+/gi);
    const covered = urlSpans.map(match => ({ start: match.start, end: match.end }));
    const groups = [];
    function group(title, expression, why, action, cover = true) {
      const matches = findOccurrences(text, expression).filter(match => !overlaps(match, urlSpans));
      if (cover) addSpans(covered, matches);
      groups.push({
        title,
        status: matches.length ? 'review' : 'passed',
        found: matches.length ? `Found ${matches.length} item${matches.length === 1 ? '' : 's'} to verify.` : 'Passed. No matching items were found.',
        why,
        action,
        evidence: factItems(text, matches).map(item => evidence(item.sentence, item.match, Infinity)),
        items: factItems(text, matches),
        priority: 5,
      });
      return matches;
    }

    const prices = group(
      'Facts to verify: prices',
      /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:\/|per)\s*(?:month|mo|year|yr|user))?|\b\d[\d,]*(?:\.\d+)?\s*(?:USD|EUR|GBP)\b)/gi,
      'Prices and discounts can change, and the sentence may depend on a plan or billing interval. A mismatch can create confusion or a billing dispute.',
      'Check the current billing setup, invoice, and official pricing page for the same plan and billing period.'
    );
    const percentages = group(
      'Facts to verify: percentages',
      /\b\d+(?:\.\d+)?\s?%/g,
      'A percentage needs a defined base, audience, and time period. Without those details, readers cannot tell what the comparison means.',
      'Check the underlying analytics report or cited study, including the date range and population.'
    );
    const durations = group(
      'Facts to verify: durations and trials',
      /\b\d+(?:\.\d+)?\s*(?:[-\u2012-\u2015]\s*)?(?:days?|weeks?|months?|years?|hours?|minutes?|mins?|seconds?|secs?)\b|\b(?:free\s+trial|trial\s+(?:period|ends?|expires?))\b/gi,
      'Trial lengths, deadlines, and time claims can depend on current offer terms. Small wording differences can change what a reader expects.',
      'Check current billing terms, offer settings, and the exact trial or renewal conditions.'
    );
    const dates = group(
      'Facts to verify: dates and years',
      /\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b(?:19|20)\d{2}\b/gi,
      'Dates and years can make an offer, report, or product statement stale. A year is treated as a date reference here, not as a standalone statistic.',
      'Check the calendar, release notes, offer terms, or dated source used for the statement.'
    );

    const codeMatches = [];
    const codePatterns = [
      { label: 'Phone number', expression: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b|\b\d{8,15}\b/g },
      { label: 'Version number', expression: /\b(?:v|version\s*)?\d+\.\d+(?:\.\d+)+\b/gi },
      { label: 'Street address number', expression: /\b\d{1,6}\s+[\w.'#-]+(?:\s+[\w.'#-]+){0,4}\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|way|parkway|pkwy\.?|suite|ste\.?)\b/gi },
      { label: 'Postal code', expression: /\b\d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi },
      { label: 'Identifier', expression: /\b(?:id|ticket|order|case|ref(?:erence)?|sku)\s*(?:#|no\.?)?\s*[A-Z0-9-]*\d+[A-Z0-9-]*\b|#[A-Z]?\d{2,}\b|\b[A-Z]{1,5}[-_]\d{2,}\b/gi },
    ];
    for (const pattern of codePatterns) {
      for (const match of findOccurrences(text, pattern.expression).filter(item => !overlaps(item, urlSpans))) {
        codeMatches.push({ ...match, label: pattern.label });
      }
    }
    addSpans(covered, codeMatches);

    const absolutes = group(
      'Facts to verify: absolute claims',
      /\b(?:only|best|guaranteed|never|always|number\s+one)\b|#\s?1\b/gi,
      'Absolute wording can imply that a claim applies in every case or outranks all alternatives. Readers may challenge it if the evidence is narrower.',
      'Check the evidence and its scope in an internal report or cited source. Qualify the wording if the evidence does not support an absolute claim.'
    );

    const numberMatches = findOccurrences(text, /\b\d[\d,]*(?:\.\d+)?\b/g)
      .filter(match => !overlaps(match, covered));
    const ambiguousCodes = numberMatches.filter(match => /^\d{4}$/.test(match.value.replace(/,/g, '')));
    addSpans(covered, ambiguousCodes);
    const stats = numberMatches.filter(match => !overlaps(match, ambiguousCodes));
    groups.push({
      title: 'Facts to verify: statistics and figures',
      status: stats.length ? 'review' : 'passed',
      found: stats.length ? `Found ${stats.length} number${stats.length === 1 ? '' : 's'} that may be a count or performance figure.` : 'Passed. No standalone statistics or figures were found.',
      why: 'Counts and performance claims need context, such as the audience, baseline, and period measured. A number alone does not show how the result was calculated.',
      action: 'Check the internal report or cited study and keep the measurement period and population clear.',
      evidence: factItems(text, stats).map(item => evidence(item.sentence, item.match, Infinity)),
      items: factItems(text, stats),
      priority: 4,
    });

    const codeItems = factItems(text, codeMatches);
    for (const match of ambiguousCodes) {
      const sentence = sentenceFor(text, match.start, match.end);
      if (!codeItems.some(item => item.match === match.value && item.sentence === sentence)) {
        codeItems.push({ match: match.value, sentence, label: 'Possible four-digit code' });
      }
    }
    groups.push({
      title: 'Codes and identifiers',
      status: 'passed',
      found: codeItems.length
        ? `${codeItems.length} phone, postal, version, or identifier-like item${codeItems.length === 1 ? ' was' : 's were'} separated from claim checking.`
        : 'Passed. No phone numbers, postal codes, version strings, or obvious identifiers were found.',
      why: 'These patterns often identify contact details, locations, versions, or records rather than a factual marketing claim. The checker separates them to reduce misleading number flags.',
      action: 'Check them only if the identifier or address itself is important to this email.',
      evidence: codeItems.slice(0, 12).map(item => evidence(item.sentence, item.match)),
      items: codeItems,
      priority: 8,
    });

    return groups;
  }

  function makeCheck(title, status, found, why, action, options = {}) {
    return {
      title,
      status,
      found,
      why,
      action,
      evidence: options.evidence || [],
      priority: options.priority ?? (status === 'issue' ? 1 : status === 'review' ? 4 : 9),
    };
  }

  function extractUrls(value) {
    const matches = String(value || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
    return unique(matches.map(raw => raw.replace(/[),.;!?}\]]+$/g, '')).filter(raw => {
      try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }));
  }

  function linkEntries(content, subject, text) {
    const entries = content.anchors.map(anchor => ({
      href: String(anchor.href ?? '').trim(),
      text: normalizeText(anchor.text || anchor.imageAlt || ''),
      source: 'anchor',
    }));
    const rawUrls = unique([...extractUrls(text), ...extractUrls(subject)]);
    for (const href of rawUrls) {
      if (!entries.some(entry => entry.href === href)) entries.push({ href, text: href, source: 'text' });
    }
    return entries;
  }

  function isUnsubscribeEntry(entry) {
    return /\b(?:unsubscribe|opt[\s-]?out|preferences?)\b/i.test(`${entry.text} ${entry.href}`);
  }

  function plainCtaPhrases(text) {
    const phrases = [];
    const sentences = String(text || '').split(/\n+|(?<=[.!?])\s+/).map(normalizeText).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length > 140 || isUnsubscribeEntry({ text: sentence, href: '' })) continue;
      const matches = Array.from(sentence.matchAll(new RegExp(CTA_ACTIONS.source, 'gi')));
      if (!matches.length) continue;
      matches.forEach((match, index) => {
        const start = match.index;
        const next = matches[index + 1];
        let end = next ? next.index : sentence.length;
        if (next) {
          const boundary = sentence.slice(start, end).search(/\s+(?:and|or|then)\s*$/i);
          if (boundary >= 0) end = start + boundary;
        }
        const phrase = sentence.slice(start, end).trim().replace(/[,:;]+$/g, '');
        if (phrase) phrases.push(phrase);
      });
    }
    return phrases;
  }

  function linkAndCtaCheck(content, subject, text) {
    const entries = linkEntries(content, subject, text);
    const ctaText = String(text || '').replace(/https?:\/\/[^\s<>"'`]+/gi, ' ');
    const validUrls = unique(entries.map(entry => entry.href).filter(href => {
      try {
        const url = new URL(href);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }));
    const emptyTargets = content.anchors.filter(anchor => {
      const href = String(anchor.href ?? '').trim().toLowerCase();
      return !href || href === '#' || href === 'javascript:void(0)' || href === 'javascript:void(0);';
    });
    const emptyText = content.anchors.filter(anchor => !normalizeText(anchor.text || anchor.imageAlt));
    const genericLinkText = content.anchors.filter(anchor => /\b(?:here|click here|learn more|read more|check it out|this link)\b/i.test(anchor.text || anchor.imageAlt || ''));
    const httpLinks = entries.filter(entry => /^http:\/\//i.test(entry.href));
    const shortLinks = entries.filter(entry => {
      try {
        return SHORTENERS.has(new URL(entry.href).hostname.toLowerCase());
      } catch {
        return false;
      }
    });

    const ctaCandidates = [];
    for (const item of [...content.anchors, ...content.buttons]) {
      const label = normalizeText(item.text || item.imageAlt || '');
      if (!label || isUnsubscribeEntry({ text: label, href: item.href || '' })) continue;
      if (item.source === 'button' || CTA_VERBS.test(label)) ctaCandidates.push(label);
    }
    ctaCandidates.push(...plainCtaPhrases(ctaText));
    const ctas = unique(ctaCandidates.map(label => label.toLowerCase()));
    const passiveCtas = findOccurrences(ctaText, PASSIVE_CTA).map(match => match.value);
    const flags = [];
    if (emptyTargets.length) flags.push(`${emptyTargets.length} empty or placeholder link target${emptyTargets.length === 1 ? '' : 's'}`);
    if (emptyText.length) flags.push(`${emptyText.length} link${emptyText.length === 1 ? '' : 's'} without visible text`);
    if (genericLinkText.length) flags.push(`${genericLinkText.length} generic link label${genericLinkText.length === 1 ? '' : 's'}`);
    if (httpLinks.length) flags.push(`${httpLinks.length} link${httpLinks.length === 1 ? '' : 's'} ${httpLinks.length === 1 ? 'uses' : 'use'} HTTP instead of HTTPS`);
    if (shortLinks.length) flags.push(`${shortLinks.length} shortened link${shortLinks.length === 1 ? '' : 's'}`);
    if (ctas.length > 1) flags.push(`${ctas.length} distinct CTA labels`);
    if (!ctas.length) flags.push('no clear action CTA detected');
    if (passiveCtas.length) flags.push('generic CTA wording detected');

    const issue = emptyTargets.length > 0 || emptyText.length > 0;
    const needsReview = flags.length > 0;
    const status = issue ? 'issue' : needsReview ? 'review' : 'passed';
    const evidenceItems = [
      ...emptyTargets.map(anchor => evidence(anchor.text || anchor.href || 'Empty link target', anchor.href || '#')),
      ...emptyText.map(anchor => evidence(anchor.href || 'Link without label', anchor.href || '')),
      ...genericLinkText.map(anchor => evidence(anchor.text, anchor.text)),
      ...httpLinks.map(entry => evidence(entry.href, entry.href)),
      ...shortLinks.map(entry => evidence(entry.href, entry.href)),
      ...passiveCtas.map(value => evidence(value, value)),
    ];
    const found = `Found ${entries.length} link target${entries.length === 1 ? '' : 's'} and ${ctas.length} distinct CTA label${ctas.length === 1 ? '' : 's'}. ${flags.length ? flags.join('; ') + '.' : 'Link text and CTA wording passed these local checks.'}`;
    return {
      entries,
      urls: validUrls,
      check: makeCheck(
        'CTAs and links',
        status,
        found,
        'Readers need a clear next action, and every link should have a usable destination. Generic labels, too many competing actions, insecure links, and shorteners can make the next step less clear.',
        issue
          ? 'Replace empty or placeholder targets and give each link meaningful visible text. Confirm every destination and keep one primary action easy to identify.'
          : 'Confirm each destination is current and accessible. If there are several actions, make the intended primary action clear.',
        { evidence: evidenceItems.slice(0, 16), priority: issue ? 1 : 3 }
      ),
    };
  }

  function makeSubjectCheck(subject) {
    const value = normalizeText(subject);
    const characters = Array.from(value).length;
    const words = countWords(value);
    const flags = [];
    const evidenceItems = [];
    if (characters > 45) {
      flags.push('above the approximate 45-character mobile display guide');
      const tail = Array.from(value).slice(45).join('');
      evidenceItems.push(evidence(value, tail || value));
    }
    if (/\b(?:update|newsletter|(?:Q[1-4]\s+)?product update|new feature\s*:|weekly update|announcement)\b/i.test(value)) {
      flags.push('starts like a filing label or generic announcement');
      const phrase = value.match(/^(?:\s*)(?:update|newsletter|(?:Q[1-4]\s+)?product update|new feature\s*:|weekly update|announcement)\b/i);
      if (phrase) evidenceItems.push(evidence(value, phrase[0].trim()));
    }
    const capitalLetters = (value.match(/[A-Z]/g) || []).length;
    const letters = (value.match(/[A-Za-z]/g) || []).length;
    if (capitalLetters >= 8 && capitalLetters / Math.max(1, letters) > 0.35) {
      flags.push('excessive uppercase emphasis');
      const caps = value.match(/\b[A-Z]{3,}\b/g) || [];
      caps.slice(0, 3).forEach(match => evidenceItems.push(evidence(value, match)));
    }
    const exclamations = (value.match(/!/g) || []).length;
    if (exclamations) {
      flags.push(`${exclamations} exclamation mark${exclamations === 1 ? '' : 's'}`);
      evidenceItems.push(evidence(value, '!'));
    }
    const emojis = value.match(/\p{Extended_Pictographic}/gu) || [];
    if (emojis.length) {
      flags.push(`${emojis.length} emoji${emojis.length === 1 ? '' : 's'}`);
      emojis.slice(0, 3).forEach(match => evidenceItems.push(evidence(value, match)));
    }
    const urgency = value.match(/\b(?:act now|urgent|limited time|last chance|expires today|don't miss out|immediately|final notice)\b/gi) || [];
    if (urgency.length) {
      flags.push('urgency language');
      urgency.forEach(match => evidenceItems.push(evidence(value, match)));
    }
    return makeCheck(
      'Subject line',
      flags.length ? 'review' : 'passed',
      `${characters} characters and ${words} words. ${flags.length ? `Review: ${unique(flags).join('; ')}.` : 'Passed: no mobile-length, label-style, capitalization, punctuation, emoji, or urgency flags.'}`,
      'Many mobile inboxes show only part of a long subject, and generic labels give readers little reason to open. Capitalization, punctuation, emoji, and urgency are simple review signals, not spam verdicts.',
      flags.length
        ? 'Check whether the subject leads with the reader benefit and keeps essential information before the approximate 45-character point. Remove emphasis that does not help the reader understand the message.'
        : 'Keep the main point near the start. The 45-character guide is approximate and varies by device and inbox.',
      { evidence: evidenceItems.slice(0, 10), priority: 3 }
    );
  }

  function makeAudienceCheck(text) {
    const senderMatches = text.match(/\b(?:we|our|us|i|me|my)\b|(?:we|i)['’](?:re|ve|ll|d|m)\b/gi) || [];
    const readerMatches = text.match(/\b(?:you|your|yours)\b|you['’](?:re|ve|ll|d)\b/gi) || [];
    const sender = senderMatches.length;
    const reader = readerMatches.length;
    const dominates = sender > reader && sender > 0;
    return makeCheck(
      'Reader focus',
      dominates ? 'review' : 'passed',
      `Sender-focused pronouns: ${sender}. Reader-focused pronouns: ${reader}. ${dominates ? 'The sender is mentioned more often.' : 'The reader is mentioned at least as often as the sender.'}`,
      'A higher count of we, our, us, or I can signal that the message is centered on the sender or product. Pronoun counts are only a rough prompt and do not judge the quality of the email.',
      dominates
        ? 'Check whether each sender-focused sentence explains a reader outcome, decision, or useful next step. Keep product details only when they support that point.'
        : 'Confirm that the reader language is specific to this audience and not just a pronoun count.',
      { priority: 5 }
    );
  }

  function makeReadabilityCheck(content) {
    const text = content.text;
    const words = countWords(text);
    const sentences = sentenceRanges(text);
    const sentenceLengths = sentences.map(item => ({ ...item, words: countWords(item.text) }));
    const longSentences = sentenceLengths.filter(item => item.words > 25);
    const paragraphs = content.paragraphs.length ? content.paragraphs : (text ? [text] : []);
    const longParagraphs = paragraphs.map(value => ({ text: value, words: countWords(value) })).filter(item => item.words > 120);
    const average = sentences.length
      ? (sentenceLengths.reduce((total, item) => total + item.words, 0) / sentences.length).toFixed(1)
      : '0';
    const minutes = words ? Math.max(1, Math.ceil(words / 200)) : 0;
    const flags = [];
    if (longSentences.length) flags.push(`${longSentences.length} sentence${longSentences.length === 1 ? '' : 's'} over 25 words`);
    if (longParagraphs.length) flags.push(`${longParagraphs.length} paragraph${longParagraphs.length === 1 ? '' : 's'} over 120 words`);
    if (words > 500) flags.push('more than 500 words');
    const evidenceItems = [
      ...longSentences.slice(0, 4).map(item => evidence(item.text, item.text, Infinity)),
      ...longParagraphs.slice(0, 2).map(item => evidence(item.text, item.text.slice(0, 120))),
    ];
    return makeCheck(
      'Readability',
      flags.length ? 'review' : 'passed',
      `${words} words. Estimated reading time: about ${minutes} minute${minutes === 1 ? '' : 's'} at 200 words per minute. Average sentence length: ${average} words. ${flags.length ? `Review: ${flags.join('; ')}.` : 'Passed: no very long sentences or paragraphs were found.'}`,
      'Long sentences and dense paragraphs ask readers to hold more information at once. The reading-time estimate and thresholds are simple editing aids, not a comprehension score.',
      flags.length
        ? 'Break up the flagged sentences or paragraphs where each idea changes. Keep necessary detail, but give the reader clear pauses.'
        : 'Review the message in its actual layout as well, since the tool estimates text and does not preview inbox formatting.',
      { evidence: evidenceItems, priority: 4 }
    );
  }

  function makeSpamCheck(subject, text) {
    const source = `${subject}\n${text}`;
    const patterns = [
      {
        label: 'Urgency or pressure language',
        expression: /\b(act now|urgent|limited time|last chance|expires today|don't miss out|immediately|final notice)\b/gi,
        why: 'Pressure language can make a message feel less trustworthy or more promotional.',
        action: 'Check whether the deadline is real and relevant. State the actual date or condition when one applies.',
      },
      {
        label: 'Guarantee or absolute wording',
        expression: /\b(guaranteed|100%\s+(?:free|safe|risk[- ]free)|risk[- ]free|no obligation)\b/gi,
        why: 'Guarantees can imply more certainty than the evidence or offer terms support.',
        action: 'Verify the offer terms and evidence, then qualify any promise that is not universal.',
      },
      {
        label: 'Promotional prize wording',
        expression: /\b(once in a lifetime|winner|you have been selected|claim your prize|cash bonus)\b/gi,
        why: 'Prize and bonus phrases may read like a promotion and can be mistaken for deceptive urgency.',
        action: 'Confirm the offer is real and explain its terms plainly.',
      },
      {
        label: 'Excessive capitalization',
        expression: /\b[A-Z]{5,}\b/g,
        why: 'Several all-capital words can make copy feel louder and harder to scan.',
        action: 'Keep capitalization for names or standard abbreviations. Use ordinary sentence case for emphasis.',
      },
      {
        label: 'Repeated exclamation marks',
        expression: /!{2,}/g,
        why: 'Repeated punctuation can make a message feel more urgent than its content requires.',
        action: 'Check whether one clear sentence can communicate the same point without repeated punctuation.',
      },
    ];
    const findings = patterns.map(pattern => ({
      ...pattern,
      matches: unique(findOccurrences(source, pattern.expression).map(match => match.value)),
    })).filter(pattern => pattern.matches.length);
    const evidenceItems = findings.flatMap(pattern => pattern.matches.slice(0, 4).map(match => evidence(source, match)));
    const details = findings.map(pattern => `${pattern.label}: ${pattern.matches.join(', ')}`).join('; ');
    return makeCheck(
      'Spam-risk wording',
      findings.length ? 'review' : 'passed',
      findings.length ? details : 'Passed. None of the small local list of pressure, guarantee, prize, capitalization, or punctuation patterns were found.',
      findings.length
        ? 'These are heuristic copy signals, not a spam verdict or deliverability prediction. Their meaning depends on the message, audience, and sender history.'
        : 'The checker reviewed a short local list of wording patterns. A clean result does not predict inbox placement.',
      findings.length
        ? 'Verify that each flagged phrase is accurate and necessary. Do not treat removing a phrase as a guarantee of delivery.'
        : 'Continue to follow your normal review and sender-authentication practices.',
      { evidence: evidenceItems.slice(0, 12), priority: 5 }
    );
  }

  function collectRegexMatches(text, expressions) {
    const found = [];
    for (const expression of expressions) {
      found.push(...findOccurrences(text, expression));
    }
    const seen = new Set();
    return found.filter(match => {
      const key = `${match.start}:${match.end}:${match.value.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function makePlaceholderCheck(text) {
    const unresolved = collectRegexMatches(text, [
      /\{\{\s*[A-Za-z][\w.-]*\s*\}\}/g,
      /(?<!\{)\{\s*(?:first_?name|name|company|organization|email)\s*\}(?!\})/gi,
      /%[A-Z][A-Z0-9_]*%/g,
      /\[\s*(?:name|first name|company)\s*\]/gi,
      /\*\|[A-Z0-9_]+\|\*/gi,
      /\$\{\s*[A-Za-z][\w.-]*\s*\}/g,
    ]);
    const filler = collectRegexMatches(text, [
      /\blorem ipsum\b/gi,
      /\b(?:TODO|TBD|XXX+)\b/g,
      /\[\s*insert[^\]]*\]/gi,
      /\bplaceholder\b/gi,
    ]);
    const issues = [...unresolved, ...filler];
    const labels = [
      unresolved.length ? `${unresolved.length} unresolved personalization variable${unresolved.length === 1 ? '' : 's'}` : '',
      filler.length ? `${filler.length} filler or draft marker${filler.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return makeCheck(
      'Personalization and draft text',
      issues.length ? 'issue' : 'passed',
      issues.length ? `Found ${labels.join(' and ')}.` : 'Passed. No common unresolved personalization token or draft marker was found.',
      issues.length
        ? 'A merge field or draft marker can appear literally in a message if the sending system does not replace it. This can confuse readers and reveal unfinished copy.'
        : 'The checker searched for common merge-field and draft markers. It cannot know every custom token used by your sending platform.',
      issues.length
        ? 'Preview the message with a real test contact and replace each draft marker before sending.'
        : 'Check a rendered test message if your sending platform uses custom personalization syntax.',
      { evidence: issues.slice(0, 16).map(match => evidence(text, match.value)), priority: 1 }
    );
  }

  function makeHtmlCheck(content, options) {
    if (!content.isHtml) {
      return makeCheck(
        'HTML images and layout',
        'passed',
        'Passed. This is plain text, so there are no HTML images to inspect.',
        'Plain-text messages do not contain image alternative text or image dimensions. This check does not preview how an email client will render the message.',
        'If you send an HTML version as well, check that version for useful image descriptions and explicit image sizing.',
        { priority: 8 }
      );
    }
    const missingAlt = content.images.filter(image => !image.altPresent);
    const missingDimensions = content.images.filter(image => !image.hasDimensions);
    const hasIssue = missingAlt.length > 0;
    const hasTextAlternative = options && options.hasTextAlternative === true;
    const status = hasIssue ? 'issue' : (missingDimensions.length || !hasTextAlternative ? 'review' : 'passed');
    const ratio = Math.round(content.imageMarkupLength / Math.max(1, content.text.length + content.imageMarkupLength) * 100);
    const parts = [
      `${content.images.length} image${content.images.length === 1 ? '' : 's'} found`,
      `${ratio}% estimated image markup by source size`,
      missingAlt.length ? `${missingAlt.length} missing alt text` : 'alt attributes present',
      missingDimensions.length ? `${missingDimensions.length} without an explicit width or height` : 'dimensions specified or styled',
      hasTextAlternative
        ? 'the uploaded EML included a text/plain alternative'
        : 'a separate plain-text email version was not supplied to this check',
    ];
    const actions = [];
    if (missingAlt.length) actions.push('Add useful alt text to meaningful images.');
    if (missingDimensions.length) actions.push('Add suitable image dimensions.');
    if (!hasTextAlternative) actions.push('Confirm that your sending platform supplies a separate plain-text part when needed.');
    if (!actions.length) actions.push('The uploaded EML included both HTML and plain-text alternatives; review a test send in your email platform.');
    return makeCheck(
      'HTML images and layout',
      status,
      `${parts.join('; ')}.`,
      hasTextAlternative
        ? 'Alternative text helps explain meaningful images when they are not displayed and supports assistive technology. Explicit dimensions can reduce layout shifts; the uploaded EML also contains a text/plain part for systems or readers that use it.'
        : 'Alternative text helps explain meaningful images when they are not displayed and supports assistive technology. Explicit dimensions can reduce layout shifts, while a separate text part can help when HTML is not rendered.',
      `${actions.join(' ')} This tool does not preview email clients.`,
      {
        evidence: [
          ...missingAlt.slice(0, 8).map((image, index) => evidence(`Image ${index + 1} has no alt attribute.`, 'no alt attribute')),
          ...missingDimensions.slice(0, 8).map((image, index) => evidence(`Image ${index + 1} has no explicit width or height.`, 'no explicit width or height')),
        ],
        priority: hasIssue ? 2 : 6,
      }
    );
  }

  function makeMarketingCheck(text, entries) {
    const unsubscribe = /\b(?:unsubscribe|opt[\s-]?out|manage preferences|email preferences)\b/i.test(text)
      || entries.some(isUnsubscribeEntry);
    const postal = /\bP\.?\s*O\.?\s*Box\s+\d+\b|\b\d{1,6}\s+[\w.'#-]+(?:\s+[\w.'#-]+){0,4}\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|way|parkway|pkwy\.?|suite|ste\.?)\b/i.test(text);
    const missing = [];
    if (!unsubscribe) missing.push('no unsubscribe or preference wording detected');
    if (!postal) missing.push('no likely physical postal address detected');
    return makeCheck(
      'Marketing email essentials',
      missing.length ? 'review' : 'passed',
      missing.length
        ? `${missing.join('; ')}.`
        : 'Passed. An unsubscribe or preference reference and a likely physical postal address were detected.',
      'For marketing messages, anti-spam rules may require a working opt-out and a valid postal address. U.S. CAN-SPAM includes these requirements for commercial email, but this text scan cannot determine legal coverage or compliance.',
      missing.length
        ? 'If this is marketing email, check the rules that apply to your audience and sender. Confirm a working unsubscribe path and physical mailing address where required; this is general information, not legal advice.'
        : 'Test the opt-out link and confirm the address is valid and appropriate for the sending organization.',
      {
        evidence: [
          ...(unsubscribe ? [evidence(text, text.match(/\b(?:unsubscribe|opt[\s-]?out|manage preferences|email preferences)\b/i)?.[0] || 'unsubscribe')] : []),
          ...(postal ? [evidence(text, text.match(/\bP\.?\s*O\.?\s*Box\s+\d+\b|\b\d{1,6}\s+[\w.'#-]+(?:\s+[\w.'#-]+){0,4}\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|way|parkway|pkwy\.?|suite|ste\.?)\b/i)?.[0] || 'postal address')] : []),
        ],
        priority: 6,
      }
    );
  }

  function makeRepetitionCheck(text) {
    const words = String(text || '').toLowerCase().match(/[\p{L}]{3,}/gu) || [];
    const counts = new Map();
    for (const word of words) {
      if (STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
    const repeated = Array.from(counts.entries())
      .filter(([, count]) => count >= 4)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6);
    const questionSentences = sentenceRanges(text).filter(item => /\?\s*$/.test(item.text));
    const flags = [];
    if (repeated.length) flags.push(`${repeated.length} content word${repeated.length === 1 ? '' : 's'} repeated at least four times`);
    if (questionSentences.length > 2) flags.push(`${questionSentences.length} questions`);
    const evidenceItems = [
      ...repeated.map(([word, count]) => evidence(text, word)),
      ...questionSentences.slice(0, 4).map(item => evidence(item.text, item.text, Infinity)),
    ];
    return makeCheck(
      'Repetition and questions',
      flags.length ? 'review' : 'passed',
      flags.length
        ? `${flags.join('; ')}. ${questionSentences.length} question${questionSentences.length === 1 ? '' : 's'} detected.`
        : `Passed. No content word repeated four or more times and ${questionSentences.length} question${questionSentences.length === 1 ? '' : 's'} detected.`,
      'Repeated terms can make copy feel less focused, while several questions can ask the reader to do too much thinking at once. Repetition can also be intentional, so context matters.',
      flags.length
        ? 'Review the repeated terms and questions for a single clear point. Keep repetition when it improves clarity or emphasis.'
        : 'Check that each question has a purpose and supports the next action.',
      { evidence: evidenceItems.slice(0, 10), priority: 6 }
    );
  }

  function makeFirstLine(content) {
    const lines = content.text.split(/\n+/).map(normalizeText).filter(Boolean);
    if (lines.length > 1) return lines[0];
    return sentenceRanges(content.text)[0]?.text || lines[0] || '';
  }

  function analyze(subject, rawBody, options) {
    options = options || {};
    const content = parseContent(rawBody);
    const bodyText = content.text;
    const copyText = `${subject}\n${bodyText}`.replace(/https?:\/\/[^\s<>"'`]+/gi, ' ');
    const copyBody = bodyText.replace(/https?:\/\/[^\s<>"'`]+/gi, ' ');
    const copyContent = {
      ...content,
      text: copyBody,
      paragraphs: content.paragraphs.map(paragraph => paragraph.replace(/https?:\/\/[^\s<>"'`]+/gi, ' ')),
    };
    const firstLine = makeFirstLine(copyContent);
    const linkAudit = linkAndCtaCheck(content, subject, bodyText);
    const facts = makeFactGroups(`${subject}\n${bodyText}`);
    const hookPattern = /^(?:we\b|i\b|our\b|we['’]re\s+excited\b|introducing\b|i\s+hope\s+this\s+email\s+finds\s+you\s+well\b|hope\s+you(?:'|’)re\s+doing\s+well\b|we\s+(?:wanted|are\s+excited|are\s+pleased)\s+to\b|i\s+wanted\s+to\s+(?:reach\s+out|share)\b)/i;
    const hookMatch = firstLine.match(hookPattern);
    const marketing = makeMarketingCheck(copyBody, linkAudit.entries);
    const checks = [
      makeSubjectCheck(subject),
      makeCheck(
        'First line and hook',
        hookMatch ? 'review' : 'passed',
        firstLine
          ? `First line: “${clip(firstLine, 400)}”${hookMatch ? ' This matches a common sender-first or generic opening.' : ' No listed generic opening was detected.'}`
          : 'Passed. No first line was available to inspect.',
        'The opening line is often the first copy a reader sees after the subject. A sender-first or familiar greeting can delay the reason the email matters to the reader.',
        hookMatch
          ? 'Consider leading with the reader situation, useful information, or next step. Keep the sender context after the reason for writing.'
          : 'Check that the first line makes the purpose clear without requiring the reader to scan several paragraphs.',
        { evidence: firstLine ? [evidence(firstLine, hookMatch ? hookMatch[0].trim() : clip(firstLine, 120))] : [], priority: 4 }
      ),
      linkAudit.check,
      makeAudienceCheck(copyText),
      makeReadabilityCheck(copyContent),
      makeSpamCheck(subject, copyBody),
      makePlaceholderCheck(copyText),
      makeHtmlCheck(content, options),
      marketing,
      makeRepetitionCheck(copyText),
      ...facts,
    ];
    return {
      subject,
      text: bodyText,
      isHtml: content.isHtml,
      paragraphs: content.paragraphs,
      firstLine,
      linkUrls: linkAudit.urls,
      linkEntries: linkAudit.entries,
      images: content.images,
      imageRatio: Math.round(content.imageMarkupLength / Math.max(1, bodyText.length + content.imageMarkupLength) * 100),
      checks,
      facts,
    };
  }

  return { analyze, extractUrls, countWords };
});
