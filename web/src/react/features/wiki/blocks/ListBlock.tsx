import type { ListContent, ListItem } from '../../../../lib/contracts/wiki'
import { SegmentRenderer } from './ProseBlock'

function ListItems({ items, ordered, depth = 0 }: { items: ListItem[]; ordered: boolean; depth?: number }) {
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag
      className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-1.5 pl-5 text-[13px] text-[var(--wiki-text-secondary)]`}
      style={{ marginLeft: depth > 0 ? '0.5rem' : undefined }}
    >
      {items.map((item, i) => (
        <li key={i} className="leading-[1.65]">
          <SegmentRenderer segments={item.segments} />
          {item.children && item.children.length > 0 && (
            <ListItems items={item.children} ordered={ordered} depth={depth + 1} />
          )}
        </li>
      ))}
    </Tag>
  )
}

export default function ListBlock({ content }: { content: ListContent }) {
  return (
    <div className="my-3">
      <ListItems items={content.items} ordered={content.ordered} />
    </div>
  )
}
