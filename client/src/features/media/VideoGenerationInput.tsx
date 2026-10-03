import { MediaGenerationControls, type MediaGenerationControlsProps } from './MediaGenerationControls';
import type { MediaOperation } from '../../shared/contracts/media-generation';

export type VideoGenerationInputProps = Omit<MediaGenerationControlsProps, 'mode'> & {
  operation?: Extract<MediaOperation, 'text-to-video' | 'image-to-video'>;
};

export function VideoGenerationInput(props: VideoGenerationInputProps) {
  return <div data-video-generation-input="true"><MediaGenerationControls {...props} mode="video" operation={props.operation ?? 'text-to-video'} /></div>;
}
