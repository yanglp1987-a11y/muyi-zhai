// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

const richTextSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    p: [...(defaultSchema.attributes?.p || []), 'style'],
    h1: [...(defaultSchema.attributes?.h1 || []), 'style'],
    h2: [...(defaultSchema.attributes?.h2 || []), 'style'],
    h3: [...(defaultSchema.attributes?.h3 || []), 'style'],
    span: [...(defaultSchema.attributes?.span || []), 'style'],
    img: [...(defaultSchema.attributes?.img || []), 'style'],
  },
};

// rehype-sanitize 负责标签/属性白名单；此插件进一步限制 style 的具体值。
function sanitizeRichTextStyles() {
  const allowedSizes = new Set(['12pt','14pt','16pt','18pt','20pt','24pt','28pt','32pt']);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'element' && node.properties?.style) {
      const tag = node.tagName;
      const declarations = String(node.properties.style).split(';');
      const safe = [];
      for (const declaration of declarations) {
        const colon = declaration.indexOf(':');
        if (colon < 1) continue;
        const name = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim().toLowerCase();
        if (name === 'font-size' && allowedSizes.has(value)) safe.push('font-size: ' + value);
        if (name === 'color' && /^#[0-9a-f]{6}$/.test(value)) safe.push('color: ' + value);
        if (['p','h1','h2','h3'].includes(tag) && name === 'text-align' && ['left','center','right'].includes(value)) safe.push('text-align: ' + value);
        if (tag === 'img' && name === 'width' && /^(25|50|75|100)%$/.test(value)) safe.push('width: ' + value);
        if (tag === 'img' && name === 'height' && value === 'auto') safe.push('height: auto');
        if (tag === 'img' && name === 'max-width' && value === '100%') safe.push('max-width: 100%');
      }
      if (safe.length) node.properties.style = safe.join('; ');
      else delete node.properties.style;
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  return (tree) => {
    visit(tree);
  };
}

export default defineConfig({
  markdown: {
    processor: unified({
      rehypePlugins: [
        [rehypeSanitize, richTextSchema],
        sanitizeRichTextStyles,
      ],
    }),
  },
});
