import { digest, fail } from './database-core.mjs';

export const AGENT_AVATARS = Object.freeze(['trend', 'rebound', 'rotation']);
export function validateAvatar(value) {
  if (!AGENT_AVATARS.includes(value)) throw fail('请选择提供的三款Agent形象之一');
  return value;
}
export function avatarFor(agent) {
  if (AGENT_AVATARS.includes(agent.avatar)) return agent.avatar;
  const builtin = AGENT_AVATARS.find((avatar) => agent.id === 'showcase-' + avatar);
  return (
    builtin ?? AGENT_AVATARS[parseInt(digest(agent.id).slice(0, 8), 16) % AGENT_AVATARS.length]
  );
}
