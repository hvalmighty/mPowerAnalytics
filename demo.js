// Cross-platform demo launcher: synthetic prices, no internet needed.
process.env.DEMO = '1';
require('./server.js').start();
