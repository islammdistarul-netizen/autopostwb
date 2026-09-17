import { edgeProvider } from './edge.ts';
import { yandexProvider } from './yandex.ts';
import { piperProvider } from './piper.ts';
import { elevenlabsProvider } from './elevenlabs.ts';
import type { VoiceProvider } from './types.ts';

export const VOICE_PROVIDER_IDS = ['edge', 'yandex', 'piper', 'elevenlabs'] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

const REGISTRY: Record<VoiceProviderId, VoiceProvider> = {
  edge: edgeProvider,
  yandex: yandexProvider,
  piper: piperProvider,
  elevenlabs: elevenlabsProvider,
};

export function getVoiceProvider(id: string): VoiceProvider {
  const provider = REGISTRY[id as VoiceProviderId];
  if (!provider) throw new Error(`Unknown voice provider "${id}". Available: ${VOICE_PROVIDER_IDS.join(', ')}`);
  return provider;
}

export type { VoiceOutput, VoiceProvider, VoiceRequest } from './types.ts';
