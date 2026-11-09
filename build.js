'use strict';

const fs = require('fs');
const path = require('path');

const publicDirectory = path.join(__dirname, 'public');
const outputDirectory = path.join(__dirname, 'dist');

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.cpSync(publicDirectory, outputDirectory, { recursive: true });
console.log('Static frontend built in dist/.');
