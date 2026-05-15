require('dotenv').config();
const express = require('express');
const path    = require('path');
const { startTracking } = require('./tracker');
const routes  = require('./routes');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  startTracking();
});
