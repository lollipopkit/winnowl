import type { Translation } from '../i18n-types.js';

const zh = {
  inviteEmail: {
    subject: '[winnowl] 邀请你加入 {tenant}',
    intro: '你已获邀以 {role} 身份加入 winnowl 上的「{tenant}」。',
    acceptWithLink: '请先登录与此邮箱关联的账号，再打开链接接受邀请：',
    acceptWithToken: '请先登录与此邮箱关联的账号，再到 winnowl 控制台输入以下 token 接受邀请：',
    expires: '邀请将于 {expiresAt} 过期。',
    ignore: '如果你没想到会收到这封邀请邮件，可以直接忽略。',
  },
} satisfies Translation;

export default zh;
