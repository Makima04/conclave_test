export function extractHtmlParts(htmlContent) {
  const parsed = new DOMParser().parseFromString(htmlContent || '', 'text/html');
  const scriptNodes = Array.from(parsed.querySelectorAll('script'));
  const scripts = scriptNodes.map(script => ({
    src: script.getAttribute('src') || '',
    type: script.getAttribute('type') || '',
    content: script.textContent || '',
  }));

  scriptNodes.forEach(script => script.remove());

  return {
    headNodes: Array.from(parsed.head.childNodes).map(node => node.cloneNode(true)),
    bodyHtml: parsed.body.innerHTML || htmlContent || '',
    scripts,
  };
}
