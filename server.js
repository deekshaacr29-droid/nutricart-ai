const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.NUTRICART_API_TOKEN;

app.use(express.json({ limit: '10kb' }));

// Public health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NutriCart Playwright API'
  });
});

// Serve only the demo storefront
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Authenticate incoming requests
function authenticate(req, res, next) {
  const suppliedToken = req.get('x-api-token');

  if (!API_TOKEN || !suppliedToken) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }

  const expected = Buffer.from(API_TOKEN);
  const supplied = Buffer.from(suppliedToken);

  if (
    expected.length !== supplied.length ||
    !crypto.timingSafeEqual(expected, supplied)
  ) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid API token'
    });
  }

  next();
}

// Validate incoming meal-plan data
function validatePlan(req, res, next) {
  const body = req.body;

  if (
    !body ||
    !Array.isArray(body.availableProducts) ||
    !Array.isArray(body.excludedProducts) ||
    !Array.isArray(body.allergies) ||
    !Number.isFinite(Number(body.budget)) ||
    Number(body.budget) <= 0
  ) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid meal-plan payload'
    });
  }

  next();
}

// Run the fixed Playwright agent with JSON sent through stdin
app.post('/run-agent', authenticate, validatePlan, (req, res) => {
  const agentPath = path.join(__dirname, 'agent.js');

  const child = spawn(
    process.execPath,
    [agentPath],
    {
      cwd: __dirname,
      windowsHide: true,
      shell: false
    }
  );

  let output = '';
  let errorOutput = '';
  let responded = false;

  child.stdout.on('data', data => {
    output += data.toString();
  });

  child.stderr.on('data', data => {
    errorOutput += data.toString();
  });

  child.on('error', error => {
    if (!responded) {
      responded = true;
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  });

  child.on('close', code => {
    if (!responded) {
      responded = true;
      res.status(code === 0 ? 200 : 500).json({
        status: code === 0 ? 'completed' : 'failed',
        exitCode: code,
        output,
        error: errorOutput
      });
    }
  });

  child.stdin.on('error', error => {
    console.error('Input stream error:', error.message);
  });

  child.stdin.end(JSON.stringify(req.body));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NutriCart API running on port ${PORT}`);
});
