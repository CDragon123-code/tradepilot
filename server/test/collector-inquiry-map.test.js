'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../collector/src/inquiry-map');

test('采集器原始询盘映射为扩展的规范字段', () => {
  const raw = {
    feedbackId: 20490501872,
    inquiryCount: 1,
    createTime: 1780233698000,
    sender: { name: 'Stephany Quinonez', countryCode: 'GT', countryName: 'Guatemala' },
    ownerName: 'Sub Account',
    source: 'main_app_miniDetail_sendInquiry',
    appFrom: 'android',
    replyStatus: 1,
    lastestReplyTime: 1794463620000,
    process: 'FOLLOW',
    subject: 'Inquiry from Store Homepage',
    productInfo: [{ productId: 1601747395615, productName: 'Resin' }],
  };
  const p = M.canonicalInquiry(raw);
  assert.equal(p.询盘ID, '20490501872');
  assert.equal(p.客户名称, 'Stephany Quinonez');
  assert.equal(p.负责人, 'Sub Account');
  assert.equal(p['国家'], '危地马拉');
  assert.equal(p['来源'], 'APP mini端详情商机');
  assert.equal(p['来源端'], '安卓端');
  assert.equal(p['回复状态'], '已回复');
  assert.equal(p['询盘主题'], 'Inquiry from Store Homepage');
  assert.equal(p['产品ID'], '1601747395615');
  assert.equal(p['咨询产品'], 'Resin');
  assert.equal(p['创建时间'], '2026/05/31 21:21:38');
  assert.ok(Number(p['未联系天数']) >= 0);
  assert.equal(p['公司名称'], '', '采集器没有的字段留空，交由服务端合并保留');
  assert.equal(p['买家等级'], '');
});

test('采集器行键与业务时间保持稳定', () => {
  const raw = { feedbackId: 1001, createTime: 1780233698000 };
  assert.equal(M.platformIdOf(raw), 'inquiry:1001');
  assert.equal(M.businessAtOf(raw), '2026-05-31T13:21:38.000Z');
  assert.equal(M.platformIdOf({}), '');
  assert.equal(M.businessAtOf({}), null);
});
