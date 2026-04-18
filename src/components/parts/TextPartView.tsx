
import type { TextPart } from '../../types/a2a';

interface Props {
  part: TextPart;
}

export function TextPartView({ part }: Props) {
  return (
    <p className="text-part">{part.text}</p>
  );
}
