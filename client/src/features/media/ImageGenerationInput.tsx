import type { MediaDraft } from './useMediaDraft';
import type { MediaJob, MediaModel, MediaOperation } from '../../shared/contracts/media-generation';
import { MediaGenerationControls, type MediaGenerationControlsProps } from './MediaGenerationControls';

export type ImageGenerationInputProps = Omit<MediaGenerationControlsProps, 'mode'> & {
  operation?: Extract<MediaOperation, 'text-to-image' | 'image-to-image'>;
  media?: MediaDraft;
};

export function ImageGenerationInput(props: ImageGenerationInputProps) {
  return <MediaGenerationControls {...props} mode="image" operation={props.operation ?? 'text-to-image'} />;
}
