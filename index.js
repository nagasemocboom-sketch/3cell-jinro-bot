// Render無料枠(Web Service)用のダミーサーバー機能
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is active!');
}).listen(process.env.PORT || 3000);

const { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  ChannelType, 
  ActionRowBuilder, 
  StringSelectMenuBuilder, 
  ButtonBuilder,
  ButtonStyle,
  ComponentType 
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN_HERE';

const ROLES = {
  SEER: '占い師',
  MEDIUM: '霊媒師',
  CITIZEN: '市民',
  WOLF: '人狼'
};

const RULE_TEXT = `
📖 **【スリーマンセル人狼 - ルール概要】**
--------------------------------------------------
・**基本構造**: 12名（3名×4チーム：占い師 / 霊媒師 / 市民 / 人狼）

・**勝利条件**:
  - 🏆 **村人陣営（占い・霊媒・市民）**: 人狼チーム3名の全員追放
  - 🏆 **人狼陣営（基本勝利）**: 村人陣営の**2チーム（計6名）を全滅**させる
  - 🏆 **人狼陣営（特殊勝利）**: 同一チームを**3夜連続で殺害成功**（3連噛み）

・**チーム能力**:
  - 🔮 **占い師**: 初日ランダム白1名判明。毎夜指定した1名の白黒（人狼か否か）判明。
  - 📜 **霊媒師**: 毎夜開始時、前日追放された1名の白黒判明。
  - 🛡️ **市民（狩人）**: **3名全員生存中のみ**、毎夜自チーム以外の1名を「襲撃から護衛」。
  - 🐺 **人狼**: 毎夜1名を襲撃。

・**ゲームの流れ**:
  - **夜(60秒)**: チームVCで密談 ＆ 個人DMで能力実行（チーム内で早い者勝ち）。
  - **朝**: 全員ミュートで犠牲者発表 → 5秒後に解除され昼議論へ。
  - **昼(最長5分)**: 全員が時短ボタンを押すと即投票開始。最多得票者を追放。同票時は【30秒の弁明タイム】→【当事者以外の生存者で決選投票】（再同票は追放なし）。
--------------------------------------------------
`;

const HOST_GUIDE_TEXT = `
🛠️ **【主催者（GM）用 Bot操作ガイド】**
--------------------------------------------------
・**\`!jinro-setup\`**: 部屋作成・ルール案内を投稿します（人数不問）。
・**\`!jinro-start\`**: ゲームを開始します（要：全体会議VCに12名接続）。
・**\`!jinro-stop\`**: ゲームを強制終了し、Botが生成したカテゴリー・全チャンネルを削除して初期化します。

・**事前確認チェックリスト**:
  1. 参加者全員のDiscord設定で「サーバーメンバーからのダイレクトメッセージ（DM）許可」がONになっているか確認してください。
  2. Botに必要な権限（チャンネル管理、メンバー移動、ミュート等）が付与されているか確認してください。
--------------------------------------------------
`;

const games = new Map();

function getGame(guildId) {
  if (!games.has(guildId)) {
    games.set(guildId, {
      setupDone: false,
      active: false,
      phase: 'LOBBY',
      dayCount: 0,
      players: [],
      channels: { category: null, mainText: null, mainVoice: null, teams: {} },
      lastKilledTeam: null,
      consecutiveKills: 0,
      executedYesterday: null,
      votes: {},
      shortenVotes: new Set(),
      nightActions: { seer: null, guard: null, wolf: null },
      nightActionSubmitted: { seer: false, guard: false, wolf: false },
      runoffCandidates: []
    });
  }
  return games.get(guildId);
}

function resetGame(guildId) {
  games.delete(guildId);
}

client.once('ready', () => {
  console.log(`スリーマンセル人狼Botが起動しました: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const gameState = getGame(message.guild.id);

  if (message.content === '!jinro-setup') {
    if (gameState.setupDone) {
      return message.reply('既にセットアップ済みです。全体会議VCに12名入った状態で `!jinro-start` と入力してください。');
    }
    await handleSetupCommand(message.guild, message.channel, gameState);
  }

  if (message.content === '!jinro-start') {
    if (!gameState.setupDone) {
      return message.reply('先に `!jinro-setup` を実行してゲームエリアを作成してください。');
    }
    if (gameState.active) {
      return message.reply('既にゲームが進行中です。終了するには `!jinro-stop` を使用してください。');
    }
    await handleStartCommand(message.guild, message.channel, gameState);
  }

  if (message.content === '!jinro-stop') {
    if (!gameState.setupDone && !gameState.active) {
      return message.reply('ゲーム環境は作成されていません。');
    }
    await cleanUpAndReset(message.guild, gameState);
    message.reply('ゲームを強制終了し、作成したチャンネルを削除・初期化しました。');
  }
});

// --- セットアップコマンド（部屋・ルールの生成） ---
async function handleSetupCommand(guild, originChannel, gameState) {
  try {
    const category = await guild.channels.create({ name: 'スリーマンセル人狼', type: ChannelType.GuildCategory });
    const mainText = await guild.channels.create({ name: '全体議論チャット', type: ChannelType.GuildText, parent: category.id });
    const mainVoice = await guild.channels.create({ name: '全体会議VC', type: ChannelType.GuildVoice, parent: category.id });

    gameState.channels.category = category;
    gameState.channels.mainText = mainText;
    gameState.channels.mainVoice = mainVoice;
    gameState.setupDone = true;

    await mainText.send('🎮 **スリーマンセル人狼の準備が完了しました！**');
    await mainText.send(RULE_TEXT);
    await mainText.send(HOST_GUIDE_TEXT);

    const currentCount = mainVoice.members ? mainVoice.members.filter(m => !m.user.bot).size : 0;
    await mainText.send(`📢 **【参加者募集・待機中】**\n参加者12名全員が **「全体会議VC」** に入った状態で、再度このチャットで \`!jinro-start\` と入力するとゲームが始まります。（現在の接続人数: **${currentCount} / 12名**）`);

    if (originChannel.id !== mainText.id) {
      originChannel.send('スリーマンセル人狼の準備が完了しました。「全体議論チャット」をご確認ください。');
    }
  } catch (err) {
    console.error(err);
    originChannel.send('チャンネル生成エラーが発生しました。Botの権限を確認してください。');
  }
}

// --- ゲーム本編スタートコマンド ---
async function handleStartCommand(guild, originChannel, gameState) {
  const mainVoice = gameState.channels.mainVoice;
  const mainText = gameState.channels.mainText;

  const targetVC = (mainVoice && mainVoice.members) ? mainVoice : originChannel.voice ? originChannel.voice.channel : null;
  const vcMembers = targetVC ? targetVC.members.filter(m => !m.user.bot) : new Map();

  if (vcMembers.size < 12) {
    await mainText.send(`⚠️ **【人数不足】** 現在VCに接続されているプレイヤーは **${vcMembers.size} / 12名** です。\n参加者12名全員が **「全体会議VC」** に接続した状態で、再度 \`!jinro-start\` と入力してください。`);
    return;
  }

  await startGame(guild, Array.from(vcMembers.values()).slice(0, 12), gameState);
}

// --- チーム割り当て・チームチャンネル生成 ---
async function startGame(guild, memberArray, gameState) {
  gameState.active = true;
  gameState.dayCount = 0;
  gameState.lastKilledTeam = null;
  gameState.consecutiveKills = 0;
  gameState.executedYesterday = null;

  const shuffledMembers = memberArray.sort(() => Math.random() - 0.5);
  const teamRoles = [ROLES.SEER, ROLES.MEDIUM, ROLES.CITIZEN, ROLES.WOLF].sort(() => Math.random() - 0.5);
  const playerRoles = [];
  teamRoles.forEach(role => playerRoles.push(role, role, role));

  try {
    gameState.players = [];
    for (let i = 0; i < 12; i++) {
      const member = shuffledMembers[i];
      gameState.players.push({
        id: member.id,
        member: member,
        name: member.displayName,
        role: playerRoles[i],
        alive: true
      });
    }

    for (const roleName of Object.values(ROLES)) {
      const teamPlayers = gameState.players.filter(p => p.role === roleName);
      const teamOverwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...teamPlayers.map(p => ({ id: p.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages] }))
      ];

      const tText = await guild.channels.create({
        name: `${roleName}チーム-裏チャット`,
        type: ChannelType.GuildText,
        parent: gameState.channels.category.id,
        permissionOverwrites: teamOverwrites
      });

      const tVoice = await guild.channels.create({
        name: `${roleName}チームVC`,
        type: ChannelType.GuildVoice,
        parent: gameState.channels.category.id,
        permissionOverwrites: teamOverwrites
      });

      gameState.channels.teams[roleName] = { text: tText, voice: tVoice };
    }

    await gameState.channels.mainText.send('🚀 **12名が揃いました！役職を割り当て、チームVCを作成しました。第1夜を開始します！**');
    await startNightPhase(guild, gameState);

  } catch (err) {
    console.error(err);
    gameState.channels.mainText.send('チームチャンネル生成エラーが発生しました。');
  }
}

// --- 夜フェーズ (1分間) ---
async function startNightPhase(guild, gameState) {
  gameState.phase = 'NIGHT';
  gameState.dayCount++;
  gameState.nightActions = { seer: null, guard: null, wolf: null };
  gameState.nightActionSubmitted = { seer: false, guard: false, wolf: false };

  const mainText = gameState.channels.mainText;
  await mainText.send(`🌙 **【夜フェーズ (第${gameState.dayCount}夜 / 制限時間: 60秒)】**\n各チームは自動でチームVCへ移動しました。夜の行動を選択してください。`);

  for (const roleName of Object.values(ROLES)) {
    const team = gameState.channels.teams[roleName];
    const teamPlayers = gameState.players.filter(p => p.role === roleName);

    for (const p of teamPlayers) {
      if (p.member && p.member.voice.channel) {
        try {
          await p.member.voice.setChannel(team.voice);
          await p.member.voice.setMute(false);
        } catch (e) {}
      }
    }
  }

  if (gameState.dayCount > 1 && gameState.executedYesterday) {
    const executed = gameState.executedYesterday;
    const isWolf = executed.role === ROLES.WOLF;
    const mediumResultText = `🔮 【霊媒結果】 昨日追放された **${executed.name}** は **「${isWolf ? '人狼（黒）' : '人狼でない（白）'}」** でした。`;
    
    const mediumTeam = gameState.players.filter(p => p.role === ROLES.MEDIUM);
    for (const m of mediumTeam) {
      try { await m.member.send(mediumResultText); } catch (e) {}
    }
    await gameState.channels.teams[ROLES.MEDIUM].text.send(mediumResultText);
  }

  if (gameState.dayCount === 1) {
    const seerPlayers = gameState.players.filter(p => p.role === ROLES.SEER);
    const nonSeerVillage = gameState.players.filter(p => p.role !== ROLES.WOLF && p.role !== ROLES.SEER);
    const randomWhite = nonSeerVillage[Math.floor(Math.random() * nonSeerVillage.length)];

    const seerInitText = `🔍 【初日ランダム白】 **${randomWhite.name}** は **「白（人狼でない）」** です。`;
    for (const s of seerPlayers) {
      try { await s.member.send(seerInitText); } catch (e) {}
    }
    await gameState.channels.teams[ROLES.SEER].text.send(seerInitText);
  }

  sendNightActionMenus(guild, gameState);

  // 夜フェーズタイマー（60秒）
  setTimeout(async () => {
    if (gameState.phase === 'NIGHT') {
      await processNightResults(guild, gameState);
    }
  }, 60000);
}

async function sendNightActionMenus(guild, gameState) {
  const alivePlayers = gameState.players.filter(p => p.alive);

  for (const p of alivePlayers) {
    if (p.role === ROLES.CITIZEN) {
      const aliveCitizens = gameState.players.filter(p => p.alive && p.role === ROLES.CITIZEN);
      if (aliveCitizens.length < 3) continue;
    }

    if (p.role === ROLES.MEDIUM) continue;

    let candidates = alivePlayers;
    if (p.role === ROLES.CITIZEN) {
      candidates = alivePlayers.filter(target => target.role !== ROLES.CITIZEN);
    } else if (p.role === ROLES.WOLF) {
      candidates = alivePlayers.filter(target => target.role !== ROLES.WOLF);
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`night_action_${p.role}_${p.id}`)
      .setPlaceholder('能力の対象を選択してください')
      .addOptions(candidates.map(c => ({ label: c.name, value: c.id })));

    const row = new ActionRowBuilder().addComponents(selectMenu);

    try {
      const dm = await p.member.createDM();
      const msg = await dm.send({ content: `🌙 **【夜の行動選択】** (${p.role}能力):`, components: [row] });

      const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
      collector.on('collect', async (interaction) => {
        const key = p.role === ROLES.SEER ? 'seer' : p.role === ROLES.WOLF ? 'wolf' : 'guard';
        
        if (gameState.nightActionSubmitted[key]) {
          return interaction.reply({ content: '既にチームの他のメンバーが選択を完了しています。', ephemeral: true });
        }

        gameState.nightActionSubmitted[key] = true;
        const targetId = interaction.values[0];
        gameState.nightActions[key] = targetId;
        const targetPlayer = gameState.players.find(t => t.id === targetId);

        await interaction.reply({ content: `選択を受理しました: **${targetPlayer.name}**`, ephemeral: true });

        if (p.role === ROLES.SEER) {
          const isWolf = targetPlayer.role === ROLES.WOLF;
          const resultMsg = `🔍 【占い結果】 **${targetPlayer.name}** は **「${isWolf ? '人狼（黒）' : '人狼でない（白）'}」** です。`;
          
          const seerTeam = gameState.players.filter(sp => sp.role === ROLES.SEER);
          for (const sp of seerTeam) {
            try { await sp.member.send(resultMsg); } catch (e) {}
          }
          await gameState.channels.teams[ROLES.SEER].text.send(resultMsg);
        }
      });
    } catch (e) {}
  }
}

async function processNightResults(guild, gameState) {
  const mainText = gameState.channels.mainText;
  const mainVoice = gameState.channels.mainVoice;

  for (const p of gameState.players) {
    if (p.member && p.member.voice.channel) {
      try {
        await p.member.voice.setChannel(mainVoice);
        await p.member.voice.setMute(true);
      } catch (e) {}
    }
  }

  let killReport = '';
  const wolfTargetId = gameState.nightActions.wolf;
  const guardTargetId = gameState.nightActions.guard;

  if (gameState.dayCount === 1) {
    killReport = '☀️ 朝が来ました。初夜のため犠牲者は居ませんでした。';
  } else if (wolfTargetId) {
    if (wolfTargetId === guardTargetId) {
      killReport = '☀️ 朝が来ました。昨夜は誰も死にませんでした（護衛成功！）。';
      gameState.consecutiveKills = 0;
      gameState.lastKilledTeam = null;
    } else {
      const killedPlayer = gameState.players.find(p => p.id === wolfTargetId);
      killedPlayer.alive = false;

      if (gameState.lastKilledTeam === killedPlayer.role) {
        gameState.consecutiveKills++;
      } else {
        gameState.lastKilledTeam = killedPlayer.role;
        gameState.consecutiveKills = 1;
      }

      killReport = `☀️ 朝が来ました。無残にも **${killedPlayer.name}** が遺体となって発見されました。`;

      if (gameState.consecutiveKills >= 3) {
        await mainText.send(killReport);
        return endGame(guild, 'WOLF_TRIPLE_KILL', gameState);
      }
    }
  } else {
    killReport = '☀️ 朝が来ました。昨夜は誰も死にませんでした。';
  }

  await mainText.send(killReport);
  if (checkWinConditions(guild, gameState)) return;

  await mainText.send('⏱️ **（5秒後にマイクが解除され、昼議論がスタートします）**');
  setTimeout(async () => {
    for (const p of gameState.players) {
      if (p.member && p.member.voice.channel) {
        try {
          if (p.alive) {
            await p.member.voice.setMute(false);
          } else {
            await p.member.voice.setMute(true);
          }
        } catch (e) {}
      }
    }
    await startDayPhase(guild, gameState);
  }, 5000);
}

// --- 昼フェーズ（5分議論 ＋ 時短ボタン） ---
async function startDayPhase(guild, gameState) {
  gameState.phase = 'DAY_DISCUSSION';
  gameState.shortenVotes = new Set();
  const mainText = gameState.channels.mainText;

  const alivePlayers = gameState.players.filter(p => p.alive);
  const aliveCount = alivePlayers.length;

  const shortenBtn = new ButtonBuilder()
    .setCustomId('shorten_discussion')
    .setLabel(`⏱️ 議論を切り上げる (${gameState.shortenVotes.size}/${aliveCount})`)
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(shortenBtn);

  const discMsg = await mainText.send({
    content: `☀️ **【昼フェーズ - 議論 (第${gameState.dayCount}日目 / 制限時間: 5分)】**\n全体VCで議論を行ってください。\n生存者全員（${aliveCount}名）が下のボタンを押すと、即座に追放投票へ移行します。`,
    components: [row]
  });

  let discussionEnded = false;

  const goToVote = async () => {
    if (discussionEnded) return;
    discussionEnded = true;
    collector.stop('discussion_over');
    await startVotingPhase(guild, gameState);
  };

  // 5分（300,000ms）タイマー
  const discTimer = setTimeout(goToVote, 300000);

  const collector = discMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

  collector.on('collect', async (interaction) => {
    if (interaction.customId !== 'shorten_discussion') return;

    const voter = gameState.players.find(p => p.id === interaction.user.id);
    if (!voter || !voter.alive) {
      return interaction.reply({ content: '生存者のみボタンを使用できます。', ephemeral: true });
    }

    if (gameState.shortenVotes.has(interaction.user.id)) {
      gameState.shortenVotes.delete(interaction.user.id);
      await interaction.reply({ content: '時短希望を取り消しました。', ephemeral: true });
    } else {
      gameState.shortenVotes.add(interaction.user.id);
      await interaction.reply({ content: '時短希望を出しました。', ephemeral: true });
    }

    const currentAliveCount = gameState.players.filter(p => p.alive).length;
    const updatedBtn = new ButtonBuilder()
      .setCustomId('shorten_discussion')
      .setLabel(`⏱️ 議論を切り上げる (${gameState.shortenVotes.size}/${currentAliveCount})`)
      .setStyle(gameState.shortenVotes.size === currentAliveCount ? ButtonStyle.Success : ButtonStyle.Secondary);

    const updatedRow = new ActionRowBuilder().addComponents(updatedBtn);
    await discMsg.edit({ components: [updatedRow] }).catch(() => {});

    if (gameState.shortenVotes.size >= currentAliveCount) {
      clearTimeout(discTimer);
      await mainText.send('⚡ **全員が時短ボタンを押したため、議論を終了して投票へ移行します！**');
      await goToVote();
    }
  });
}

// --- 追放投票フェーズ (60秒) ---
async function startVotingPhase(guild, gameState) {
  gameState.phase = 'DAY_VOTE';
  const mainText = gameState.channels.mainText;

  const alivePlayers = gameState.players.filter(p => p.alive);
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('vote_select_main')
    .setPlaceholder('追放したいプレイヤーを選択')
    .addOptions(alivePlayers.map(p => ({ label: p.name, value: p.id })));

  const row = new ActionRowBuilder().addComponents(selectMenu);
  const voteMsg = await mainText.send({ content: '🗳️ **【追放投票 / 制限時間: 60秒】** 下のメニューから追放したいプレイヤーを選択してください:', components: [row] });

  gameState.votes = {};

  const collector = voteMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });

  collector.on('collect', async (interaction) => {
    const voter = gameState.players.find(p => p.id === interaction.user.id);
    if (!voter || !voter.alive) {
      return interaction.reply({ content: '生存者のみ投票可能です。', ephemeral: true });
    }
    gameState.votes[interaction.user.id] = interaction.values[0];
    await interaction.reply({ content: `投票を受理しました。`, ephemeral: true });

    if (Object.keys(gameState.votes).length === alivePlayers.length) {
      collector.stop('all_voted');
    }
  });

  collector.on('end', async () => {
    await processVoteResults(guild, false, gameState);
  });
}

async function processVoteResults(guild, isRunoff = false, gameState) {
  const mainText = gameState.channels.mainText;
  const voteCounts = {};

  let voteDetails = '📊 **【投票内訳】**\n';
  Object.entries(gameState.votes).forEach(([voterId, targetId]) => {
    const voter = gameState.players.find(p => p.id === voterId);
    const target = gameState.players.find(p => p.id === targetId);
    if (voter && target) {
      voteDetails += `- ${voter.name} ➡️ **${target.name}**\n`;
    }
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });
  await mainText.send(voteDetails);

  let maxVotes = 0;
  let topCandidates = [];
  for (const [targetId, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      topCandidates = [targetId];
    } else if (count === maxVotes) {
      topCandidates.push(targetId);
    }
  }

  if (topCandidates.length > 1) {
    if (!isRunoff) {
      gameState.runoffCandidates = topCandidates;
      const candidateNames = topCandidates.map(id => gameState.players.find(p => p.id === id).name).join(' さん, ');
      
      await mainText.send(`⚠️ **同票（${maxVotes}票）となりました！**\n対象者: **${candidateNames}**\nこれより **30秒間の弁明タイム** ののち、決選投票を行います。`);
      
      setTimeout(async () => {
        await startRunoffVote(guild, gameState);
      }, 30000);
      return;
    } else {
      await mainText.send('⚖️ **決選投票でも同数となったため、本日の追放者は無しとなります。**');
      gameState.executedYesterday = null;
      return startNightPhase(guild, gameState);
    }
  }

  const executedPlayer = gameState.players.find(p => p.id === topCandidates[0]);
  executedPlayer.alive = false;
  gameState.executedYesterday = executedPlayer;

  await mainText.send(`⚖️ 投票の結果、**${executedPlayer.name}** が追放されました。`);

  if (checkWinConditions(guild, gameState)) return;
  await startNightPhase(guild, gameState);
}

async function startRunoffVote(guild, gameState) {
  gameState.phase = 'RUNOFF_VOTE';
  const mainText = gameState.channels.mainText;

  const eligibleVoters = gameState.players.filter(p => p.alive && !gameState.runoffCandidates.includes(p.id));
  const candidatePlayers = gameState.players.filter(p => gameState.runoffCandidates.includes(p.id));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('vote_select_runoff')
    .setPlaceholder('決選投票の対象を選択')
    .addOptions(candidatePlayers.map(p => ({ label: p.name, value: p.id })));

  const row = new ActionRowBuilder().addComponents(selectMenu);
  const voteMsg = await mainText.send({ content: '🗳️ **【決選投票 / 制限時間: 30秒】** 当事者以外の生存者は投票してください:', components: [row] });

  gameState.votes = {};

  const collector = voteMsg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 30000 });

  collector.on('collect', async (interaction) => {
    if (!eligibleVoters.some(p => p.id === interaction.user.id)) {
      return interaction.reply({ content: '決選投票の対象者（当事者）および死亡者は投票できません。', ephemeral: true });
    }
    gameState.votes[interaction.user.id] = interaction.values[0];
    await interaction.reply({ content: `決選投票を受理しました。`, ephemeral: true });

    if (Object.keys(gameState.votes).length === eligibleVoters.length) {
      collector.stop('all_voted');
    }
  });

  collector.on('end', async () => {
    await processVoteResults(guild, true, gameState);
  });
}

function checkWinConditions(guild, gameState) {
  const aliveWolves = gameState.players.filter(p => p.alive && p.role === ROLES.WOLF).length;

  const seerAlive = gameState.players.some(p => p.alive && p.role === ROLES.SEER);
  const mediumAlive = gameState.players.some(p => p.alive && p.role === ROLES.MEDIUM);
  const citizenAlive = gameState.players.some(p => p.alive && p.role === ROLES.CITIZEN);

  let deadTeamsCount = 0;
  if (!seerAlive) deadTeamsCount++;
  if (!mediumAlive) deadTeamsCount++;
  if (!citizenAlive) deadTeamsCount++;

  if (aliveWolves === 0) {
    endGame(guild, 'VILLAGE_WIN', gameState);
    return true;
  }

  if (deadTeamsCount >= 2) {
    endGame(guild, 'WOLF_WIN_2TEAMS_DEAD', gameState);
    return true;
  }

  return false;
}

async function endGame(guild, reason, gameState) {
  const mainText = gameState.channels.mainText;

  let resultMsg = '🎉 **【ゲーム終了】**\n';
  if (reason === 'VILLAGE_WIN') {
    resultMsg += '🏆 **村人陣営の勝利！**（人狼チームが全滅しました）\n';
  } else if (reason === 'WOLF_WIN_2TEAMS_DEAD') {
    resultMsg += '🏆 **人狼陣営の勝利！**（村人陣営の2チームが全滅しました）\n';
  } else if (reason === 'WOLF_TRIPLE_KILL') {
    resultMsg += '🏆 **人狼陣営の即時勝利！**（同一チームを3夜連続殺害成功しました！）\n';
  }

  resultMsg += '\n📋 **【正解・役職一覧】**\n';
  gameState.players.forEach(p => {
    resultMsg += `- ${p.name} : **${p.role}** [${p.alive ? '生存' : '死亡'}]\n`;
  });

  await mainText.send(resultMsg);

  for (const p of gameState.players) {
    if (p.member && p.member.voice.channel) {
      try { await p.member.voice.setMute(false); } catch (e) {}
    }
  }

  resetGame(guild.id);
}

async function cleanUpAndReset(guild, gameState) {
  if (gameState.channels.category) {
    const channels = guild.channels.cache.filter(c => c.parentId === gameState.channels.category.id);
    for (const [id, ch] of channels) {
      try { await ch.delete(); } catch (e) {}
    }
    try { await gameState.channels.category.delete(); } catch (e) {}
  }
  resetGame(guild.id);
}

console.log('🔑 Discordへログインを試みています...');
client.login(TOKEN).catch(err => {
  console.error('❌ Discordへのログインに失敗しました:', err);
});