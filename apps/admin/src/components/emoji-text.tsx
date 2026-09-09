import { emojify } from 'node-emoji';

export function EmojiText({ children }: { children: string }) {
  return <>{emojify(children)}</>;
}
