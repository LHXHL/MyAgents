export type AskUserQuestionHostCapability = 'none' | 'native-card' | 'text';

export interface HostInteractionCapability {
  askUserQuestion: AskUserQuestionHostCapability;
}

export const DEFAULT_HOST_INTERACTION: HostInteractionCapability = {
  askUserQuestion: 'none',
};
