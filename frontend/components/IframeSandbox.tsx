// 接收 Rust 传来的“脏 HTML”，并将其安全地放入 Iframe 沙盒中执行，同时伪造 SillyTavern 的全局 API（Bridge）

import React, { useEffect, useRef } from 'react';

interface SandboxProps {
  htmlContent: string;
  onSlashCommand: (cmd: string) => void;
}

export const IframeSandbox: React.FC<SandboxProps> = ({ htmlContent, onSlashCommand }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument;
    if (!doc) return;

    // 1. 构建沙盒 HTML 骨架
    const sandboxHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
        <style>
          body { background: transparent; color: #eee; margin: 0; font-family: sans-serif; }
          /* 这里可以注入卡片全局 CSS */
        </style>
      </head>
      <body>
        <div id="st-chat-message">${htmlContent}</div>
        <script>
          // 2. 伪造 SillyTavern API (Bridge)
          window.triggerSlash = async (cmd) => {
            window.parent.postMessage({ type: 'SLASH_COMMAND', payload: cmd }, '*');
          };
          
          // 3. 强制执行 HTML 中的 <script> 标签 (innerHTML 默认不执行脚本)
          document.querySelectorAll('#st-chat-message script').forEach(oldScript => {
            const newScript = document.createElement('script');
            newScript.textContent = oldScript.textContent;
            document.body.appendChild(newScript);
          });
        </script>
      </body>
      </html>
    `;

    doc.open();
    doc.write(sandboxHTML);
    doc.close();

    // 4. 监听来自沙盒内部的交互事件
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'SLASH_COMMAND') {
        onSlashCommand(event.data.payload);
      }
    };
    window.addEventListener('message', handleMessage);

    return () => window.removeEventListener('message', handleMessage);
  }, [htmlContent, onSlashCommand]);

  return (
    <iframe
      ref={iframeRef}
      style={{ width: '100%', height: '800px', border: 'none', background: '#1e1e1e' }}
      sandbox="allow-scripts allow-same-origin"
      title="Card Sandbox"
    />
  );
};