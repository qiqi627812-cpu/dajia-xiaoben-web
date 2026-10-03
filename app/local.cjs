const path=require('path');
process.env.LOCAL_DB_DIR ||= path.resolve(__dirname,'../.local-data');
process.env.APP_HOSTNAME ||= '127.0.0.1';
require('./server');
