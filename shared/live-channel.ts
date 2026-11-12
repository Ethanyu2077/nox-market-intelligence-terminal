/** An on-demand public feed. Release removes the listener and any unused upstream resource. */
export type LiveSource = (
  params: Record<string, string>,
  emit: (data: unknown) => void,
  unavailable: () => void,
) => () => void;
export type LiveChannelState = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'unavailable';
