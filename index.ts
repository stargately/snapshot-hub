import bodyParser from 'body-parser';
import frameguard from 'frameguard';
import cors from 'cors';
import api from './server';
import session from 'express-session';

export default (app, server) => {
  app.set('trust proxy', 1);
  app.use(
    session({
      secret: 'stargately snapshot',
      cookie: {
        maxAge: 60000
      }
    })
  );
  app.use(bodyParser.json({ limit: '20mb' }));
  app.use(bodyParser.urlencoded({ limit: '20mb', extended: false }));
  app.use(frameguard({ action: 'deny' }));
  app.use(cors());
  app.use('/api', api);
  app.get('/*', (req, res) => res.redirect('https://snapshot.page/#/balancer'));
};
