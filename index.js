const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const http = require('http');

let fileConfig = {};
try {
  fileConfig = require('./config.json');
} catch {}

function parseAdminIds(value, fallback) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
      return [String(parsed)];
    } catch {
      // plain text — could be single ID or comma-separated IDs
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return fallback || [];
}

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || fileConfig.BOT_TOKEN,
  GUILD_ID: process.env.GUILD_ID || fileConfig.GUILD_ID || '',
  ADMIN_IDS: parseAdminIds(process.env.ADMIN_IDS, fileConfig.ADMIN_IDS),
  MIN_ACCOUNT_AGE_DAYS: Number(process.env.MIN_ACCOUNT_AGE_DAYS || fileConfig.MIN_ACCOUNT_AGE_DAYS || 30),
  TOP_COUNT: Number(process.env.TOP_COUNT || fileConfig.TOP_COUNT || 15),
  WEEK_MS: Number(process.env.WEEK_MS || fileConfig.WEEK_MS || 7 * 24 * 60 * 60 * 1000),
};

const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- Data persistence ----------
let db = { guilds: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function getGuildData(guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      weekStart: Date.now(),
      leaderboard: { channelId: null, messageId: null },
      members: {},      // inviterId -> { score, joined, left }
      invitedBy: {},    // joinerId -> inviterId
      counted: [],      // userIds already counted this week (anti-rejoin)
      totalJoined: 0,
    };
    saveDb();
  }
  return db.guilds[guildId];
}

function resetWeek(gd) {
  gd.members = {};
  gd.invitedBy = {};
  gd.counted = [];
  gd.totalJoined = 0;
  gd.weekStart = Date.now();
  saveDb();
}

// Weekly rollover check — resets counts when 7 days elapsed
function ensureWeek(gd) {
  if (Date.now() - gd.weekStart >= WEEK_MS) {
    resetWeek(gd);
  }
}

// ---------- Invite cache ----------
// guildId -> Map(code -> uses)
const inviteCache = new Map();

async function refreshInviteCache(guild) {
  try {
    const invites = await guild.invites.fetch();
    const map = new Map();
    for (const [code, inv] of invites) map.set(code, inv.uses || 0);
    inviteCache.set(guild.id, map);
  } catch (e) {
    console.error(`Failed to fetch invites for ${guild.name}:`, e.message);
  }
}

// Per-guild queue: serializes join processing so simultaneous joins
// don't race on the invite diff and don't burst the API
const guildQueues = new Map();
function enqueue(guildId, fn) {
  const prev = guildQueues.get(guildId) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error('Join queue error:', e));
  guildQueues.set(guildId, next);
  return next;
}

function isAdmin(interaction) {
  const member = interaction.member;
  if (!member) return false;
  if ((config.ADMIN_IDS || []).includes(member.id)) return true;
  // interaction.member is a plain object — use interaction.guild for owner check
  return member.id === interaction.guild?.ownerId;
}

// ---------- Leaderboard ----------
function buildEmbed(gd, guild) {
  const top = Object.entries(gd.members)
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => b.score - a.score || b.joined - a.joined)
    .slice(0, TOP_COUNT);

  let desc;
  if (top.length === 0) {
    desc = 'لا توجد دعوات معتمدة هذا الأسبوع بعد.';
  } else {
    desc = top
      .map((m, i) => {
        const medals = ['🥇', '🥈', '🥉'];
        const rank = i < 3 ? medals[i] : `**#${i + 1}**`;
        return `${rank} <@${m.id}> — ⭐ **${m.score}** دعوة | دخل: ${m.joined} | خرج: ${m.left}`;
      })
      .join('\n');
  }

  const nextReset = gd.weekStart + WEEK_MS;
  const remain = Math.max(0, nextReset - Date.now());
  const days = Math.floor(remain / 86400000);
  const hours = Math.floor((remain % 86400000) / 3600000);
  const mins = Math.floor((remain % 3600000) / 60000);

  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 أكثر الأعضاء دعوةً هذا الأسبوع')
    .setDescription(desc)
    .setFooter({
      text: `يتجدد الأسبوع بعد: ${days} يوم ${hours} ساعة ${mins} دقيقة | إجمالي الداخلين: ${gd.totalJoined}`,
    })
    .setTimestamp();
}

async function updateLeaderboard(guild) {
  const gd = getGuildData(guild.id);
  ensureWeek(gd);
  if (!gd.leaderboard.channelId || !gd.leaderboard.messageId) return;
  try {
    const channel = await guild.channels.fetch(gd.leaderboard.channelId);
    const msg = await channel.messages.fetch(gd.leaderboard.messageId);
    await msg.edit({ embeds: [buildEmbed(gd, guild)] });
  } catch (e) {
    console.error('Leaderboard update failed:', e.message);
  }
}

// ---------- Counting logic ----------
async function countJoin(guild, inviterId, joinerId) {
  const gd = getGuildData(guild.id);
  ensureWeek(gd);

  // Anti-rejoin: same person can't be counted twice in one week
  if (gd.counted.includes(joinerId)) return;

  if (!gd.members[inviterId]) gd.members[inviterId] = { score: 0, joined: 0, left: 0 };
  gd.members[inviterId].score++;
  gd.members[inviterId].joined++;
  gd.counted.push(joinerId);
  gd.invitedBy[joinerId] = inviterId;
  gd.totalJoined++;
  saveDb();
  await updateLeaderboard(guild);
}

async function countLeave(guild, userId) {
  const gd = getGuildData(guild.id);
  ensureWeek(gd);
  if (!gd.counted.includes(userId)) return;

  const inviterId = gd.invitedBy[userId];
  if (inviterId && gd.members[inviterId]) {
    gd.members[inviterId].score--;
    gd.members[inviterId].left++;
    if (gd.members[inviterId].score < 0) gd.members[inviterId].score = 0;
  }
  saveDb();
  await updateLeaderboard(guild);
}

// ---------- Bot ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged — must be enabled in Dev Portal
    GatewayIntentBits.GuildInvites,
  ],
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('تثبيت لوحة إحصائيات الدعوات في روم')
    .addChannelOption((o) =>
      o.setName('channel').setDescription('الروم اللي تنزل فيه اللوحة').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('تصفير إحصائيات الأسبوع يدوياً')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Cache invites for all guilds
  for (const guild of c.guilds.cache.values()) {
    await refreshInviteCache(guild);
    getGuildData(guild.id);
  }

  // Register commands
  const targetGuild = config.GUILD_ID ? c.guilds.cache.get(config.GUILD_ID) : null;
  try {
    if (targetGuild) {
      await targetGuild.commands.set(commands);
      console.log(`Commands registered in ${targetGuild.name}`);
    } else {
      await c.application.commands.set(commands);
      console.log('Commands registered globally');
    }
  } catch (e) {
    console.error('Command registration failed:', e.message);
  }

  // Hourly refresh of countdown on leaderboard
  setInterval(async () => {
    for (const guild of c.guilds.cache.values()) {
      const gd = getGuildData(guild.id);
      ensureWeek(gd);
      await updateLeaderboard(guild);
    }
  }, 60 * 60 * 1000);
});

// Keep invite cache fresh
client.on(Events.InviteCreate, (invite) => {
  const map = inviteCache.get(invite.guild.id) || new Map();
  map.set(invite.code, invite.uses || 0);
  inviteCache.set(invite.guild.id, map);
});

client.on(Events.InviteDelete, (invite) => {
  const map = inviteCache.get(invite.guild.id);
  if (map) map.delete(invite.code);
});

// New member joined
client.on(Events.GuildMemberAdd, (member) => {
  enqueue(member.guild.id, () => handleMemberJoin(member));
});

async function handleMemberJoin(member) {
  const guild = member.guild;
  const gd = getGuildData(guild.id);
  ensureWeek(gd);

  // Already counted this week → ignore (anti-rejoin)
  if (gd.counted.includes(member.id)) {
    await refreshInviteCache(guild);
    return;
  }

  // Detect which invite was used by comparing uses count
  let usedInvite = null;
  try {
    const fresh = await guild.invites.fetch();
    const oldMap = inviteCache.get(guild.id) || new Map();
    const newMap = new Map();

    for (const [code, inv] of fresh) {
      const prev = oldMap.get(code) || 0;
      if ((inv.uses || 0) > prev && !usedInvite) {
        usedInvite = inv;
      }
      newMap.set(code, inv.uses || 0);
    }
    inviteCache.set(guild.id, newMap);
  } catch (e) {
    console.error('Invite diff failed:', e.message);
    return;
  }

  const inviterId = usedInvite?.inviter?.id;
  if (!inviterId || inviterId === member.id) return;

  // Joiner's account must be old enough (> MIN_ACCOUNT_AGE_DAYS)
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
  if (ageDays < (config.MIN_ACCOUNT_AGE_DAYS || 30)) return;

  // Count immediately on join
  await countJoin(guild, inviterId, member.id);
}

// Member left
client.on(Events.GuildMemberRemove, async (member) => {
  await countLeave(member.guild, member.id);
});

// Slash command handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Defer immediately — we have 15 min instead of 3s for slow operations
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  try {
    await handleCommand(interaction);
  } catch (e) {
    console.error('Command error:', e);
    await interaction.editReply({ content: `❌ صار خطأ: ${e.message}` }).catch(() => {});
  }
});

async function handleCommand(interaction) {
  if (interaction.commandName === 'setup') {
    if (!isAdmin(interaction)) {
      return interaction.editReply({ content: '❌ هذا الأمر للأدمن فقط.' });
    }
    const channel = interaction.options.getChannel('channel');
    if (!channel) {
      return interaction.editReply({ content: '❌ ما لقيت الروم المحدد.' }).catch(() => {});
    }
    const gd = getGuildData(interaction.guild.id);
    ensureWeek(gd);

    try {
      const msg = await channel.send({ embeds: [buildEmbed(gd, interaction.guild)] });
      gd.leaderboard = { channelId: channel.id, messageId: msg.id };
      saveDb();
      await msg.pin().catch(() => {});
      await interaction.editReply({ content: `✅ تم تثبيت لوحة الدعوات في <#${channel.id}>` });
    } catch (e) {
      await interaction.editReply({ content: `❌ فشل إرسال اللوحة: ${e.message}` }).catch(() => {});
    }
  }

  if (interaction.commandName === 'reset') {
    if (!isAdmin(interaction)) {
      return interaction.editReply({ content: '❌ هذا الأمر للأدمن فقط.' });
    }
    const gd = getGuildData(interaction.guild.id);
    resetWeek(gd);
    await updateLeaderboard(interaction.guild);
    await interaction.editReply({ content: '✅ تم تصفير إحصائيات الأسبوع وبدأ أسبوع جديد.' }).catch(() => {});
  }
}

// Prevent bot crash on unhandled errors
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
client.on('error', (e) => console.error('Client error:', e));

// Health endpoint — keeps Render web service alive and passes health checks
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('InviteStatsBot is running');
}).listen(PORT, () => console.log(`HTTP server on port ${PORT}`));

client.login(config.BOT_TOKEN);
