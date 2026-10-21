import type { Translation } from '../i18n-types.js';

const zh = {
  inviteEmail: {
    subject: '[winnowl] 邀请你加入 {tenant}',
    intro: '你被邀请以 {role} 角色加入 winnowl 上的「{tenant}」。',
    acceptWithLink: '点击链接接受邀请(请先用本邮箱对应账号登录):',
    acceptWithToken: '请用本邮箱对应账号登录 winnowl 控制台,凭以下 token 接受邀请:',
    expires: '邀请将于 {expiresAt} 过期。',
    ignore: '如果这不是你预期的邀请,忽略本邮件即可。',
  },
} satisfies Translation;

export default zh;
