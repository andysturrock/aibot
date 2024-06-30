export function generateLoggedInHTML(provider: string) {
  const hmtl = `
<!DOCTYPE html>
<html>
<body>

<h1>Authentication Success</h1>
<p>You are now authenticated with ${provider}.  Go back to Slack and run your command again to interact with the bot.</p>

</body>
</html>
    `;
  return hmtl;
}
