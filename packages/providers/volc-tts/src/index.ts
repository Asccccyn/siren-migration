export { VolcBatchTtsProvider } from './batch.ts';
export type { VolcTtsConfig } from './batch.ts';
export { VolcBidirectionalTtsProvider } from './bidirectional.ts';
export type { VolcBidirectionalTtsConfig } from './bidirectional.ts';
export { EVENT as VOLC_TTS_EVENT, encodeClientEventFrame, decodeServerFrame as decodeTtsServerFrame } from './bidirectional-protocol.ts';
export type { BidirectionServerFrame } from './bidirectional-protocol.ts';
export { mapStyleToVolcAudio } from './voice-map.ts';
export type { VolcTtsAudioParams } from './voice-map.ts';
