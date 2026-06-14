async function setCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.error("No TELEGRAM_BOT_TOKEN provided.");
    console.error("Usage: TELEGRAM_BOT_TOKEN='your_token' node scripts/setup_bot_commands.js");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const commands = [
    { command: "lang", description: "Change Language / تغيير اللغة" },
    { command: "help", description: "How to add products / طريقة الاستخدام" }
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands })
  });

  if (res.ok) {
    console.log("Successfully registered /lang and /help commands with BotFather!");
  } else {
    console.error("Failed to register commands:", await res.text());
  }
}

setCommands();
