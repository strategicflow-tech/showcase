/* Strategic Flow permissioned client feedback carousel. No external dependencies. */
(function () {
  'use strict';

  var reviews = [
    {
      quote: "I have to admit, when I tried your free audit, I wasn't expecting much. But I gave your Decision Friction Model a shot, and two months later, I'm glad I did. We ended up changing pretty much everything about our emails. Even the way we discuss and plan them as a team is different now. And the best part? Customers are responding better. Funny how you get so used to doing things one way that you stop questioning them. Thanks for opening my eyes.",
      name: 'Dan A.',
      role: 'Growth Manager'
    },
    {
      quote: "The first page of the audit annoyed me a little. Mostly because it was right... We'd spent weeks polishing an email nobody could make sense of in ten seconds. We moved the important bit to the top, cut half the copy, and sent a much simpler version. Finally, people knew what we wanted them to do.",
      name: 'Rachel M.',
      role: 'Head of Communications'
    },
    {
      quote: "Our team kept arguing about subject lines. The audit showed us the bigger problem was everything after the open. That was a bit embarrassing, honestly. But helpful. We stopped trying to sound clever and started answering the questions customers were actually asking. I'd pay for that clarity again.",
      name: 'Oliver K.',
      role: 'Customer Experience Lead'
    },
    {
      quote: "I sent over one of our launch emails thinking we'd get a few copy suggestions. Instead, we got a completely different way to organize the message. It took a couple of rounds to get everyone on board, but the end result felt so much easier to read. No magic tricks. Someone finally pointed out what we'd been missing.",
      name: 'Mina R.',
      role: 'Product Marketing Manager'
    },
    {
      quote: "Short version: the audit saved us from sending another painfully long update. The team had crammed everything in because nobody wanted their part left out. The review made it obvious how much work we were putting on the reader. We rewrote it in an afternoon. Wish we'd asked earlier.",
      name: 'James T.',
      role: 'Operations Director'
    }
  ];

  var prefix = 'sf-reviews';
  var css = `
    .sf-reviews{--sfr-accent:#2dd4bf;--sfr-ink:#f6f8fa;--sfr-muted:#a7b2c0;--sfr-card:#15212b;--sfr-border:rgba(180,195,210,.22);--sfr-radius:16px;--sfr-font:system-ui,sans-serif;--sfr-heading:var(--sfr-font);box-sizing:border-box;position:relative;grid-column:1 / -1;width:calc(100% - 40px);max-width:min(1100px,calc(100vw - 40px));margin:clamp(28px,4vw,56px) auto;padding:clamp(20px,3.5vw,42px);color:var(--sfr-ink);font-family:var(--sfr-font);background:var(--sfr-card);border:1px solid var(--sfr-border);border-top:3px solid var(--sfr-accent);border-radius:var(--sfr-radius);box-shadow:0 16px 54px rgba(0,0,0,.18);overflow:hidden;isolation:isolate;scroll-margin-block:24px 160px}
    .sf-reviews *{box-sizing:border-box}
    .sf-reviews__eyebrow{margin:0 0 10px;color:var(--sfr-accent);font:600 11px/1.4 var(--sfr-font);letter-spacing:.14em;text-transform:uppercase}
    .sf-reviews__title{margin:0 0 clamp(18px,2.5vw,28px);color:inherit;font:700 clamp(25px,3.3vw,36px)/1.12 var(--sfr-heading);letter-spacing:-.025em}
    .sf-reviews__viewport{position:relative;overflow:hidden}
    .sf-reviews__track{position:relative}
    .sf-reviews__slide{position:relative;padding:clamp(20px,3vw,36px);border:1px solid var(--sfr-border);border-radius:var(--sfr-radius);background:color-mix(in srgb,var(--sfr-card) 95%,var(--sfr-accent) 5%);display:flex;flex-direction:column;justify-content:center}
    .sf-reviews__quote{margin:0;color:var(--sfr-ink);font:500 clamp(18px,2.15vw,26px)/1.45 var(--sfr-heading);letter-spacing:-.012em}
    .sf-reviews__author{margin:18px 0 0;color:var(--sfr-ink);font:700 15px/1.4 var(--sfr-font)}
    .sf-reviews__role{display:block;margin-top:4px;color:var(--sfr-muted);font:400 13px/1.5 var(--sfr-font)}
    .sf-reviews__controls{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:20px}
    .sf-reviews__arrows,.sf-reviews__dots{display:flex;align-items:center;gap:8px}
    .sf-reviews__button{display:grid;place-items:center;min-width:44px;min-height:44px;padding:8px;border:1px solid var(--sfr-border);border-radius:999px;background:transparent;color:var(--sfr-ink);font:600 20px/1 var(--sfr-font);cursor:pointer;transition:background .18s,border-color .18s,color .18s}
    .sf-reviews__button:hover{background:color-mix(in srgb,var(--sfr-accent) 14%,transparent);border-color:var(--sfr-accent)}
    .sf-reviews__button:focus-visible,.sf-reviews__dot:focus-visible,.sf-reviews__cta:focus-visible{outline:3px solid var(--sfr-accent);outline-offset:3px}
    .sf-reviews__dot{width:12px;height:12px;padding:0;border:0;border-radius:50%;background:var(--sfr-muted);opacity:.45;cursor:pointer}
    .sf-reviews__dot[aria-current="true"]{background:var(--sfr-accent);opacity:1;transform:scale(1.18)}
    .sf-reviews__bottom{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:24px}
    .sf-reviews__permission{margin:0;color:var(--sfr-muted);font:400 12px/1.55 var(--sfr-font)}
    .sf-reviews__cta{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:11px 20px;border:1px solid var(--sfr-accent);border-radius:calc(var(--sfr-radius)*.6);background:var(--sfr-accent);color:var(--sfr-cta-ink,#071411);font:700 14px/1.2 var(--sfr-font);text-decoration:none;white-space:nowrap;transition:filter .18s,transform .18s}
    .sf-reviews__cta:hover{filter:brightness(1.08);transform:translateY(-1px);text-decoration:none}
    #cookie-banner.sf-reviews-consent-inline{position:relative!important;inset:auto!important;grid-column:1/-1;width:calc(100% - 40px)!important;max-width:1100px!important;margin:18px auto!important;z-index:auto!important;box-sizing:border-box!important}
    @media(max-width:600px){.sf-reviews{width:calc(100% - 28px);max-width:calc(100vw - 28px);margin:14px auto;padding:12px;border-radius:min(var(--sfr-radius),14px)}.sf-reviews__eyebrow{margin-bottom:5px;font-size:10px}.sf-reviews__title{margin-bottom:11px;font-size:22px;line-height:1.14}.sf-reviews__slide{padding:13px}.sf-reviews__quote{font-size:15px;line-height:1.4;letter-spacing:0}.sf-reviews__author{margin-top:10px;font-size:14px}.sf-reviews__role{font-size:12px}.sf-reviews__controls{margin-top:8px}.sf-reviews__bottom{align-items:stretch;flex-direction:column;gap:8px;margin-top:11px}.sf-reviews__permission{font-size:11px;line-height:1.35}.sf-reviews__cta{width:100%;min-height:42px;padding:9px 14px}}
    @media(max-width:600px){#cookie-banner.sf-reviews-consent-inline{width:calc(100% - 28px)!important;margin:14px auto!important;padding:14px!important}}
    body.sf-reviews-page :where(main,section,article,header,footer,div,ul,nav){min-width:0}
    @media(max-width:700px){
      html:has(body.sf-reviews-page){overflow-x:clip}
      body.sf-reviews-page{width:100%;overflow-x:clip}
      body.sf-reviews-page :where(img,svg,video,canvas,iframe){max-width:100%}
      body.sf-reviews-page table{display:block;width:100%;max-width:100%;overflow-x:auto}
      body.sf-reviews-page .toc-list{display:flex!important;flex-wrap:wrap;width:100%!important;max-width:100%!important;gap:8px 12px}
      body.sf-reviews-page .footer-links,body.sf-reviews-page .nav-links{flex-wrap:wrap;max-width:100%}
      body.sf-reviews-page nav{max-width:100%;flex-wrap:wrap}
      body.sf-reviews-page:has(.hamburger) .nav-links{display:none!important}
      body.sf-reviews-page .tab{min-width:0;max-width:100%;overflow-wrap:anywhere}
      body.sf-reviews-page .stat-item,body.sf-reviews-page .ba-panel,body.sf-reviews-page .rs-cell{min-width:0;max-width:100%}
      body.sf-reviews-page .dbt-nav{height:auto;min-height:56px;padding:12px 16px;gap:10px;flex-wrap:wrap}
      body.sf-reviews-page .dbt-nav .nav-links{gap:8px 14px}
      body.sf-reviews-page .page{grid-template-columns:minmax(0,1fr)!important;padding-inline:16px!important;gap:24px!important}
    }
    @media(prefers-reduced-motion:reduce){.sf-reviews__button,.sf-reviews__cta{transition:none}.sf-reviews__cta:hover{transform:none}}
  `;

  function rgb(value) {
    var match = String(value || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  }

  function luminance(color) {
    var c = rgb(color);
    return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0;
  }

  function alpha(color) {
    var match = String(color || '').match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i);
    return match ? Number(match[1]) : 1;
  }

  function resolvedColor(value, root) {
    if (!value) return '';
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:' + value;
    root.appendChild(probe);
    var color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }

  function pageBackground(root) {
    var node = root;
    while (node && node !== document.documentElement) {
      var bg = getComputedStyle(node).backgroundColor;
      var channels = rgb(bg);
      if (channels && (channels[0] + channels[1] + channels[2] > 8)) return bg;
      node = node.parentElement;
    }
    return getComputedStyle(document.documentElement).backgroundColor || 'rgb(255,255,255)';
  }

  function pickAccent(root) {
    var styles = getComputedStyle(document.documentElement);
    var preferred = ['teal','cyan','green','mint','accent','signal','gold','amber','primary','brand'];
    var names = [];
    for (var i = 0; i < styles.length; i++) {
      var name = styles[i];
      if (name.indexOf('--') !== 0) continue;
      var lower = name.slice(2).toLowerCase();
      var rank = preferred.findIndex(function (part) { return lower.indexOf(part) >= 0; });
      if (rank >= 0) names.push({ name: name, rank: rank });
    }
    names.sort(function (a, b) { return a.rank - b.rank; });
    for (var n = 0; n < names.length; n++) {
      var color = resolvedColor('var(' + names[n].name + ')', root);
      if (rgb(color) && alpha(color) >= 0.65 && luminance(color) > 0.12 && luminance(color) < 0.92) return color;
    }
    var buttons = Array.from(document.querySelectorAll('a,button,input[type="submit"]'));
    for (var b = 0; b < buttons.length; b++) {
      var style = getComputedStyle(buttons[b]);
      var bg = style.backgroundColor;
      if (rgb(bg) && alpha(bg) >= 0.65 && luminance(bg) > 0.12 && luminance(bg) < 0.92) return bg;
    }
    return '#2dd4bf';
  }

  function theme(root, host, hero) {
    var bg = pageBackground(hero || document.body);
    var dark = luminance(bg) < 0.48;
    var text = getComputedStyle(document.body).color || (dark ? '#f6f8fa' : '#17212b');
    var accent = pickAccent(root);
    var title = hero && hero.querySelector('h1,h2');
    var cardRadius = '16px';
    var candidates = document.querySelectorAll('[class*="card"],[class*="panel"],article');
    for (var i = 0; i < Math.min(candidates.length, 50); i++) {
      var radius = getComputedStyle(candidates[i]).borderRadius;
      if (radius && radius !== '0px') { cardRadius = radius; break; }
    }
    var bodyStyle = getComputedStyle(document.body);
    host.style.setProperty('--sfr-accent', accent);
    host.style.setProperty('--sfr-ink', text);
    host.style.setProperty('--sfr-muted', dark ? 'color-mix(in srgb,' + text + ' 68%,transparent)' : 'color-mix(in srgb,' + text + ' 68%,transparent)');
    host.style.setProperty('--sfr-card', dark
      ? 'color-mix(in srgb,' + bg + ' 94%,white 6%)'
      : 'color-mix(in srgb,' + bg + ' 94%,black 6%)');
    host.style.setProperty('--sfr-border', 'color-mix(in srgb,' + accent + ' 35%, ' + text + ' 18%)');
    host.style.setProperty('--sfr-radius', cardRadius);
    host.style.setProperty('--sfr-font', bodyStyle.fontFamily || 'system-ui,sans-serif');
    host.style.setProperty('--sfr-heading', title ? getComputedStyle(title).fontFamily : bodyStyle.fontFamily);
    host.style.setProperty('--sfr-cta-ink', luminance(accent) > 0.64 ? '#10201b' : '#ffffff');
  }

  function findHero() {
    var headings = Array.from(document.querySelectorAll('h1'));
    var heading = headings.find(function (h) {
      var style = getComputedStyle(h);
      return h.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (!heading) return null;
    return heading.closest('.hero,[class*="hero"],section,header,main,article') || heading.parentElement;
  }

  function keepConsentBannerInFlow(host) {
    var banner = document.querySelector('#cookie-banner.visible');
    if (!banner || !host.parentNode) return;
    banner.classList.add('sf-reviews-consent-inline');
    ['position', 'top', 'right', 'bottom', 'left', 'width', 'max-width', 'margin', 'z-index', 'box-sizing'].forEach(function (property) {
      banner.style.removeProperty(property);
    });
    host.parentNode.insertBefore(banner, host);
  }

  function mount() {
    if (!document.body || document.body.hasAttribute('data-sf-reviews-off')) return;
    if (document.querySelector('.sf-reviews')) return;
    document.body.classList.add('sf-reviews-page');
    var styleTag = document.createElement('style');
    styleTag.id = 'sf-reviews-styles';
    styleTag.textContent = css;
    document.head.appendChild(styleTag);

    var host = document.createElement('section');
    host.className = 'sf-reviews';
    host.setAttribute('aria-label', 'Customer feedback');
    host.setAttribute('aria-roledescription', 'carousel');
    host.setAttribute('tabindex', '0');
    host.style.visibility = 'hidden';
    host.innerHTML = '<p class="sf-reviews__eyebrow">Customer feedback</p><h2 class="sf-reviews__title">What teams say after the audit</h2><div class="sf-reviews__viewport"><div class="sf-reviews__track"></div></div><div class="sf-reviews__controls"><div class="sf-reviews__arrows"><button class="sf-reviews__button sf-reviews__prev" type="button" aria-label="Previous review">‹</button><button class="sf-reviews__button sf-reviews__next" type="button" aria-label="Next review">›</button></div><div class="sf-reviews__dots" aria-label="Choose a review"></div></div><div class="sf-reviews__bottom"><p class="sf-reviews__permission">Shared with permission. Company names kept private at their request.</p><a class="sf-reviews__cta" href="https://strategic-flow-audit.replit.app/">Run the free audit →</a></div>';

    var hero = findHero();
    if (hero && hero.parentNode) hero.parentNode.insertBefore(host, hero.nextSibling);
    else {
      var target = document.querySelector('hr,footer') || document.body.lastElementChild;
      if (target && target.parentNode) target.parentNode.insertBefore(host, target);
      else document.body.appendChild(host);
    }
    keepConsentBannerInFlow(host);
    theme(document.body, host, hero);

    var track = host.querySelector('.sf-reviews__track');
    var dots = host.querySelector('.sf-reviews__dots');
    reviews.forEach(function (review, index) {
      var slide = document.createElement('article');
      slide.className = 'sf-reviews__slide';
      slide.setAttribute('role', 'group');
      slide.setAttribute('aria-roledescription', 'slide');
      slide.setAttribute('aria-label', (index + 1) + ' of ' + reviews.length);
      var quote = document.createElement('p');
      quote.className = 'sf-reviews__quote';
      quote.textContent = '“' + review.quote + '”';
      var author = document.createElement('p');
      author.className = 'sf-reviews__author';
      author.textContent = review.name;
      var role = document.createElement('span');
      role.className = 'sf-reviews__role';
      role.textContent = review.role;
      author.appendChild(role);
      slide.appendChild(quote);
      slide.appendChild(author);
      track.appendChild(slide);
      var dot = document.createElement('button');
      dot.className = 'sf-reviews__dot';
      dot.type = 'button';
      dot.setAttribute('aria-label', 'Show review ' + (index + 1));
      dot.addEventListener('click', function () { show(index, true); });
      dots.appendChild(dot);
    });

    var slides = Array.from(track.children);
    var dotButtons = Array.from(dots.children);
    var viewport = host.querySelector('.sf-reviews__viewport');
    var maxHeight = Math.max.apply(null, slides.map(function (slide) { return slide.getBoundingClientRect().height; }));
    track.style.height = Math.ceil(maxHeight) + 'px';
    slides.forEach(function (slide, index) {
      slide.style.position = 'absolute';
      slide.style.inset = '0';
      slide.style.visibility = index === 0 ? 'visible' : 'hidden';
      slide.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');
    });
    viewport.style.height = Math.ceil(maxHeight) + 'px';
    host.style.visibility = 'visible';
    var current = 0;
    function show(index, announce) {
      current = (index + slides.length) % slides.length;
      slides.forEach(function (slide, i) {
        slide.style.visibility = i === current ? 'visible' : 'hidden';
        slide.setAttribute('aria-hidden', i === current ? 'false' : 'true');
      });
      dotButtons.forEach(function (dot, i) {
        if (i === current) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
      if (announce) host.setAttribute('aria-label', 'Customer feedback, review ' + (current + 1) + ' of ' + slides.length);
    }
    show(0, false);
    var stopAutoplay = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var timer;
    function stop() { stopAutoplay = true; window.clearInterval(timer); }
    if (!stopAutoplay) timer = window.setInterval(function () { show(current + 1, false); }, 7000);
    host.addEventListener('mouseenter', stop, { once: true });
    host.addEventListener('focusin', stop, { once: true });
    host.addEventListener('touchstart', stop, { once: true, passive: true });
    host.querySelector('.sf-reviews__prev').addEventListener('click', function () { stop(); show(current - 1, true); });
    host.querySelector('.sf-reviews__next').addEventListener('click', function () { stop(); show(current + 1, true); });
    host.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); stop(); show(current - 1, true); }
      if (event.key === 'ArrowRight') { event.preventDefault(); stop(); show(current + 1, true); }
    });
    var touchX = 0;
    host.addEventListener('touchstart', function (event) { touchX = event.changedTouches[0].clientX; }, { passive: true });
    host.addEventListener('touchend', function (event) {
      var delta = event.changedTouches[0].clientX - touchX;
      if (Math.abs(delta) > 45) { stop(); show(current + (delta < 0 ? 1 : -1), true); }
    }, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
