(function () {
  const TOKEN = '[[SF_TEARDOWN_COUNT]]';
  fetch('/teardowns.json', { credentials: 'same-origin' })
    .then((response) => { if (!response.ok) throw new Error('Unable to load teardown catalog'); return response.json(); })
    .then((catalog) => {
      const count = String(catalog && catalog.meta && catalog.meta.total);
      if (!/^\d+$/.test(count)) throw new Error('Invalid teardown catalog count');
      window.SF_TEARDOWN_COUNT = count;
      const replace = (value) => value && value.split(TOKEN).join(count);
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => { node.nodeValue = replace(node.nodeValue); });
      document.querySelectorAll('[content], [title], [aria-label]').forEach((element) => {
        ['content', 'title', 'aria-label'].forEach((attribute) => {
          if (element.hasAttribute(attribute)) element.setAttribute(attribute, replace(element.getAttribute(attribute)));
        });
      });
    })
    .catch((error) => console.error('Teardown count initialization failed:', error));
})();
