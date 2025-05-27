const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const sharp = require('sharp');
const fs = require("fs")
const cors = require("cors");
const multer = require('multer');

const app = express();
const port = 3000;
const bot = new Telegraf('8045210429:AAEIGN_hISxY3p2mTprZ_IDRbxSdN376p7k');

// Папка для хранения загруженных файлов
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

// Фильтрация по типам файлов
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['text/plain', 'application/pdf'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Недопустимый тип файла'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // ограничение размера файла до 10 МБ
});

// Добавляем вспомогательные функции для EJS
app.locals.getFileIcon = (filePath) => {
  if (!filePath) return 'far fa-file';

  const ext = filePath.split('.').pop().toLowerCase();
  switch (ext) {
    case 'pdf': return 'far fa-file-pdf text-danger';
    case 'doc': case 'docx': return 'far fa-file-word text-primary';
    case 'xls': case 'xlsx': return 'far fa-file-excel text-success';
    case 'jpg': case 'jpeg': case 'png': case 'gif': return 'far fa-file-image text-info';
    case 'txt': return 'far fa-file-alt';
    default: return 'far fa-file';
  }
};

app.locals.getFileName = (filePath) => {
  return filePath ? filePath.split('/').pop().split('\\').pop() : '';
};


bot.catch((err, ctx) => {
  console.error('Ошибка в боте:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
});

// Настройка подключения к PostgreSQL
const pool = new Pool({
  user: 'myuser',
  host: 'dpg-d0q0s2umcj7s73ek7qtg-a',
  database: 'checktask',
  password: '79kFxnhLfpyYVLAUgqPIMD9qbKUfbgjx',
  port: 5432,
  ssl: {
    rejectUnauthorized: false // Для облачных БД обычно требуется SSL
  }
});

pool.connect()
  .then(() => {
    console.log('Подключено к PostgreSQL')
  }).catch((err) => {
    console.error('Ошибка подключения к PostgreSQL:', err)
  });

app.use(session({
  secret: 'Checktask',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Для разработки с HTTP
}));
app.use(cors())
app.set('view engine', 'ejs');
app.use(express.json())
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Настройка EJS
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');


// Маршруты
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null }); // Здесь передаем error как null
});

app.post('/register', async (req, res) => {
  const { username, email, phone, post, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    // Проверяем существование пользователя
    const userExists = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (userExists.rows.length > 0) {
      // Передаем сообщение об ошибке в шаблон EJS
      return res.render('register', { error: 'Пользователь с таким именем уже существует' });
    }
    // Проверяем существование пользователя по почте
    const userExistsByEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (userExistsByEmail.rows.length > 0) {
      // Передаем сообщение об ошибке в шаблон EJS
      return res.render('register', { error: 'Пользователь с такой почтой уже существует' });
    }

    // Создаем нового пользователя
    await pool.query(
      'INSERT INTO users (username, email, phone, post, password) VALUES ($1, $2, $3, $4, $5)',
      [username, email, phone, post, hashedPassword]
    );
    // Перенаправляем пользователя после успешной регистрации
    res.redirect('/profile');
  } catch (err) {
    console.error(err);
    // Исправьте здесь: правильное имя представления
    res.render('register', { error: 'Ошибка сервера' }); // Убедитесь, что выводите error корректно
  }
});


app.get('/login', (req, res) => {
  const error = req.query.error;
  res.render('login.ejs', { error });
});

// Маршруты аутентизации 
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rows.length > 0) {
      const user = result.rows[0];
      const validPassword = await bcrypt.compare(password, user.password);

      if (validPassword) {
        req.session.userId = user.id;
        return res.redirect('/profile');
      } else {
        // Неверный пароль
        return res.redirect('/login?error=invalid_password');
      }
    } else {
      // Пользователь не найден
      return res.redirect('/login?error=user_not_found');
    }
  } catch (err) {
    console.error(err);
    return res.redirect('/login?error=server_error');
  }
});

// Маршрут профиля с заметками
app.get('/profile', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  try {
    // Получаем данные пользователя
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const user = userResult.rows[0];

    // Получаем заметки пользователя
    const notesResult = await pool.query(
      'SELECT * FROM notes WHERE user_id = $1 ORDER BY time DESC',
      [req.session.userId]
    );

    res.render('profile', {
      user: user,
      notes: notesResult.rows
    });
  } catch (err) {
    console.error(err);
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});
// отображение заметок профиля
function isAuthenticated(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}


// Маршрут для страницы с заметками
app.get('/main', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const { stage, theme } = req.query;
  const userId = req.session.userId;

  try {
    let query = `
      SELECT n.* 
      FROM notes n
      WHERE n.user_id = $1 
        AND n.is_archived = false
        AND NOT EXISTS (
          SELECT 1 FROM note_users nu 
          WHERE nu.note_id = n.note_id
        )
        AND (n.deadline IS NULL)
    `;

    const params = [userId];
    let paramCount = 1;

    // Добавляем фильтр по стадии
    if (stage) {
      paramCount++;
      query += ` AND n.stage = $${paramCount}`;
      params.push(stage);
    }

    // Добавляем фильтр по теме
    if (theme) {
      paramCount++;
      query += ` AND n.theme = $${paramCount}`;
      params.push(theme);
    }

    query += ` ORDER BY n.time DESC`;

    const notesResult = await pool.query(query, params);

    const formatDescription = (text) => {
      const marked = require('marked');
      return marked.parse(text || '');
    };

    res.render('main', {
      notes: notesResult.rows,
      user: { id: req.session.userId },
      formatDescription: formatDescription,
      stage: stage || '',
      theme: theme || ''
    });
  } catch (err) {
    console.error(err);
    res.redirect('/profile');
  }
});

// Маршрут для создания заметки
app.post('/notes', upload.single('file'), async (req, res) => {
  if (!req.session.userId) {
    return res.status(403).json({ error: 'Не авторизован' });
  }
  try {
    const { title, theme, description, stage = 'planned' } = req.body;

    // Валидация обязательных полей
    if (!title || !theme || !description || !stage) {
      return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены' });
    }

    // Путь к файлу
    const filePath = req.file ? req.file.path : null;

    // Создаем заметку
    const noteResult = await pool.query(
      `INSERT INTO notes (title, theme, description, user_id, stage, file_path)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, theme, description, req.session.userId, stage, filePath]
    );

    const note = noteResult.rows[0]; // Получаем весь объект заметки
    res.json({ success: true, note });
  } catch (err) {
    console.error('Ошибка при создании заметки:', err);
    res.status(500).json({
      error: 'Ошибка сервера',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Маршрут для удаления заметки
app.delete('/notes/:id', async (req, res) => {
  if (!req.session.userId) return res.sendStatus(403);

  try {
    await pool.query(
      'DELETE FROM notes WHERE note_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Маршрут для обновления заметки
app.put('/api/notes/:id', upload.single('file'), async (req, res) => {
  const noteId = parseInt(req.params.id, 10);
  const { title, theme, description, stage } = req.body;

  if (!title || !theme || !description || isNaN(noteId)) {
    return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены' });
  }

  let file = null;
  if (req.file) {
    file = req.file.filename; // или path — зависит от настройки Multer
  }

  let query;
  let values;

  if (file) {
    query = `
      UPDATE notes 
      SET title = $1, theme = $2, description = $3, stage = $4, file = $5
      WHERE note_id = $6 RETURNING *`;
    values = [title, theme, description, stage, file, noteId];
  } else {
    query = `
      UPDATE notes 
      SET title = $1, theme = $2, description = $3, stage = $4
      WHERE note_id = $5 RETURNING *`;
    values = [title, theme, description, stage, noteId];
  }

  try {
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Заметка не найдена' });
    }
    res.json({ success: true, note: result.rows[0] });
  } catch (err) {
    console.error('Ошибка при обновлении заметки:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения данных заметки
app.get('/api/notes/:id', async (req, res) => {
  try {
    const noteId = parseInt(req.params.id);
    if (isNaN(noteId)) {
      return res.status(400).json({ error: 'ID заметки должен быть числом' });
    }

    const result = await pool.query(`
      SELECT n.*, u.username as author_username
      FROM notes n
      JOIN users u ON n.user_id = u.id
      WHERE n.note_id = $1
    `, [noteId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Заметка не найдена' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Ошибка при получении заметки:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для поиска заметок
app.get('/api/notes/search', async (req, res) => {
  try {
    const searchQuery = req.query.q || '';
    if (!searchQuery.trim()) {
      return res.status(400).json({ message: 'Введите текст для поиска' });
    }

    const result = await pool.query(
      `SELECT note_id, title, description, time
       FROM notes 
       WHERE user_id = $1 AND (title ILIKE $2 OR description ILIKE $2)
       ORDER BY time DESC
       LIMIT 20`,
      [req.session.userId, `%${searchQuery}%`]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});



app.locals.getStageClass = (stage) => {
  const classes = {
    planned: 'bg-secondary',
    in_progress: 'bg-primary',
    testing: 'bg-warning text-dark',
    completed: 'bg-success'
  };
  return classes[stage] || 'bg-secondary';
};

app.locals.getStageText = (stage) => {
  const texts = {
    planned: 'Запланировано',
    in_progress: 'В работе',
    testing: 'Тестирование',
    completed: 'Завершено'
  };
  return texts[stage] || stage;
};

// Обновление стадии выполнения
app.patch('/api/notes/:id/stage', async (req, res) => {
  if (!req.session.userId) {
    return res.status(403).json({ error: 'Не авторизован' });
  }

  try {
    const { stage } = req.body;
    const result = await pool.query(
      `UPDATE notes 
       SET stage = $1
       WHERE note_id = $2 AND user_id = $3
       RETURNING *`,
      [stage, req.params.id, req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Заметка не найдена' });
    }

    res.json({
      success: true,
      note: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для архивирования заметки
app.post('/api/notes/:id/archive', async (req, res) => {
  if (!req.session.userId) {
    return res.status(403).json({ error: 'Не авторизован' });
  }

  try {
    await pool.query(
      `UPDATE notes SET is_archived = TRUE WHERE note_id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/archive', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');

  try {
    const result = await pool.query(`SELECT n.* 
   FROM notes n
   WHERE n.user_id = $1 
     AND n.is_archived = true
   ORDER BY n.time DESC`, [req.session.userId]);

    res.render('archive', {
      user: { id: req.session.userId },
      notes: result.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Маршрут для получения архивных заметок
app.get('/api/notes/archived', async (req, res) => {
  if (!req.session.userId) {
    return res.status(403).json({ error: 'Не авторизован' });
  }

  try {
    const result = await pool.query(`
      SELECT * FROM notes
      WHERE user_id = $1 AND is_archived = TRUE
      ORDER BY time DESC
    `, [req.session.userId]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/notes/:id/unarchive', async (req, res) => {
  if (!req.session.userId) {
    return res.status(403).json({ error: 'Не авторизован' });
  }

  try {
    await pool.query(
      `UPDATE notes SET is_archived = FALSE WHERE note_id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отдельный маршрут для проверки напоминаний
app.get('/api/reminders/check', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(403).json({ error: 'Не авторизован' });
    }

    const result = await pool.query(`
      SELECT title FROM notes 
      WHERE user_id = $1 
      AND deadline IS NOT NULL
      AND deadline BETWEEN NOW() AND NOW() + INTERVAL '1 hour'
    `, [req.session.userId]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для страницы напоминаний
app.get('/time', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  try {
    const result = await pool.query(`
      SELECT n.*, u.username, u.telegram_id
      FROM notes n
      JOIN users u ON n.user_id = u.id
      WHERE n.user_id = $1 
      AND n.deadline IS NOT NULL
      AND n.is_archived = false
      ORDER BY n.deadline ASC`,
      [req.session.userId]
    );

    res.render('time', {
      notes: result.rows,
      user: { id: req.session.userId }
    });
  } catch (err) {
    console.error('Ошибка при загрузке напоминаний:', err);
    res.status(500).send('Ошибка сервера');
  }
});
// Команда /start
bot.start((ctx) => {
  ctx.reply('Привет! Я ваш бот-напоминалка. Используйте команду /link для получения кода.');
});

// Команда бота для генерации кода привязки
bot.command('link', async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Проверяем, есть ли пользователь с таким telegram_id
    const userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    if (userResult.rows.length > 0) {
      return ctx.reply('ℹ️ Ваш аккаунт уже привязан.');
    }

    await ctx.replyWithHTML(
      `🔑 <b>Код привязки:</b> <code>${code}</code>\n\n` +
      `Перейдите в свой профиль на сайте и введите этот код.\n` +
      `Код действителен 10 минут.`
    );

    // Сохраняем код для последующей привязки
    await pool.query(
      'INSERT INTO telegram_link_codes (code, telegram_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'10 minutes\')',
      [code, telegramId]
    );

  } catch (err) {
    console.error('Ошибка в команде /link:', err);
    await ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
  }
});


// Обработчик привязки Telegram аккаунта
app.post('/api/link-telegram', async (req, res) => {
  if (!req.session.userId) return res.status(403).json({ error: 'Не авторизован' });

  const { code } = req.body;

  try {
    await pool.query('BEGIN');

    // 1. Находим код и проверяем его
    const codeResult = await pool.query(
      `SELECT telegram_id FROM telegram_link_codes 
       WHERE code = $1 AND expires_at > NOW() AND is_used = false
       LIMIT 1`,
      [code]
    );

    if (codeResult.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'Неверный или просроченный код' });
    }

    const { telegram_id } = codeResult.rows[0];

    // 2. Проверяем, не привязан ли уже этот Telegram ID
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1 AND id != $2',
      [telegram_id, req.session.userId]
    );

    if (userCheck.rows.length > 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'Этот Telegram аккаунт уже привязан к другому пользователю' });
    }

    // 3. Привязываем Telegram ID к пользователю
    await pool.query(
      'UPDATE users SET telegram_id = $1 WHERE id = $2',
      [telegram_id, req.session.userId]
    );

    // 4. Помечаем код как использованный
    await pool.query(
      'UPDATE telegram_link_codes SET is_used = true WHERE code = $1',
      [code]
    );

    await pool.query('COMMIT');
    res.json({ success: true, telegram_id });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Ошибка привязки Telegram:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Генерация кода привязки
app.post('/api/generate-link-code', async (req, res) => {
  if (!req.session.userId) return res.status(403).json({ error: 'Не авторизован' });

  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await pool.query(
      `INSERT INTO telegram_link_codes (code, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
      [code, req.session.userId]
    );

    res.json({ success: true, code });
  } catch (err) {
    console.error('Ошибка генерации кода:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Установка напоминания
app.post('/set-reminder', async (req, res) => {
  const { noteId, reminderDate } = req.body;

  if (!noteId || !reminderDate) {
    return res.status(400).json({ message: 'Не указан ID заметки или дата' });
  }

  const date = new Date(reminderDate);

  if (isNaN(date.getTime())) {
    return res.status(400).json({ message: 'Некорректный формат даты' });
  }

  // ❌ Проверка: если дата из прошлого — ошибка
  if (date < new Date()) {
    return res.status(400).json({ message: 'Нельзя установить напоминание на прошедшую дату' });
  }

  try {
    await pool.query(
      `UPDATE notes SET deadline = $1 WHERE note_id = $2`,
      [date, noteId]
    );

    return res.json({ message: 'Напоминание успешно установлено' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Ошибка при установке напоминания' });
  }
});

// Удаление времени сдачи
app.post('/remove-deadline', async (req, res) => {
  const { noteId } = req.body;

  try {
    await pool.query(
      `UPDATE notes SET deadline = NULL WHERE note_id = $1`,
      [noteId]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при удалении времени сдачи');
  }
});

// Проверка напоминаний
cron.schedule('* * * * *', async () => {
  try {
    // 1. Очищаем просроченные коды привязки
    await pool.query(
      `DELETE FROM telegram_link_codes WHERE expires_at < NOW()`
    );

    // 2. Получаем активные заметки с telegram_id
    const notes = await pool.query(`
      SELECT n.*, u.telegram_id 
      FROM notes n
      JOIN users u ON n.user_id = u.id
      WHERE n.is_archived = false
        AND u.telegram_id IS NOT NULL
        AND n.deadline IS NOT NULL
    `);

    const now = new Date();

    for (const note of notes.rows) {
      const deadline = new Date(note.deadline);
      const isDeadlineApproaching =
        deadline > now &&
        deadline <= new Date(now.getTime() + 24 * 60 * 60 * 1000); // За 24 часа

      const isOverdue = deadline <= now;

      try {
        if (isDeadlineApproaching && !note.reminder_sent) {
          const deadlineTime = deadline.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });

          await bot.telegram.sendMessage(
            note.telegram_id,
            `⚠️ Напоминание: "${note.title}"\nЗавершается завтра в ${deadlineTime}`
          );

          await pool.query(
            `UPDATE notes SET reminder_sent = TRUE WHERE note_id = $1`,
            [note.note_id]
          );
        }

        if (isOverdue && !note.is_archived) {
          await bot.telegram.sendMessage(
            note.telegram_id,
            `❌ Ваша заметка "${note.title}" просрочена.`
          );

          // Сбрасываем флаг, чтобы можно было отправить напоминание снова, если дедлайн изменится
          await pool.query(
            `UPDATE notes SET reminder_sent = FALSE WHERE note_id = $1`,
            [note.note_id]
          );
        }
      } catch (err) {
        if (err.code === 400) {
          console.log(`Пользователь ${note.telegram_id} не начал диалог с ботом`);
        } else if (err.code === 403) {
          console.log(`Пользователь ${note.telegram_id} заблокировал бота`);
        } else {
          console.error('Ошибка отправки:', err);
        }
      }
    }
  } catch (err) {
    console.error('Ошибка в задаче cron:', err);
  }
});;

app.get('/download/:noteId', async (req, res) => {
  const { noteId } = req.params;

  try {
    const result = await pool.query('SELECT file_path FROM notes WHERE note_id = $1', [noteId]);
    if (!result.rows.length || !result.rows[0].file_path) {
      return res.status(404).send('Файл не найден');
    }

    res.download(result.rows[0].file_path); // автоматически отправляет файл
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Маршрут для страницы групп

app.get('/group', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const { stage, theme } = req.query;
  const userId = req.session.userId;

  try {
    // Сначала получаем username текущего пользователя
    const currentUserResult = await pool.query(
      'SELECT username FROM users WHERE id = $1',
      [userId]
    );

    if (currentUserResult.rows.length === 0) {
      return res.redirect('/login');
    }

    const currentUsername = currentUserResult.rows[0].username;

    let query = `
      SELECT 
        n.note_id, 
        n.title, 
        n.theme, 
        n.stage, 
        n.description, 
        n.file_path, 
        n.time, 
        n.is_archived,
        u.username AS creator_username, 
        u.email AS creator_email,
        json_agg(
          json_build_object(
            'user_id', u2.id,
            'username', u2.username,
            'email', u2.email,
            'role', nu.role
          )
        ) AS participants,
        nu_current.role AS current_user_role
      FROM notes n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN note_users nu ON n.note_id = nu.note_id
      LEFT JOIN users u2 ON nu.user_id = u2.id
      LEFT JOIN note_users nu_current ON n.note_id = nu_current.note_id AND nu_current.user_id = $1
      WHERE EXISTS (
        SELECT 1 FROM note_users nu2 
        WHERE nu2.note_id = n.note_id AND nu2.user_id = $1
      )
      AND n.is_archived = false
    `;

    const params = [userId];
    let paramCount = 1;

    // Добавляем фильтр по стадии, если задан
    if (stage && typeof stage === 'string') {
      paramCount++;
      query += ` AND n.stage = $${paramCount}`;
      params.push(stage);
    }

    // Добавляем фильтр по теме, если задан
    if (theme && typeof theme === 'string') {
      paramCount++;
      query += ` AND n.theme = $${paramCount}`;
      params.push(theme);
    }

    query += ` GROUP BY n.note_id, u.username, u.email, nu_current.role ORDER BY n.time DESC`;

    const notesResult = await pool.query(query, params);

    const formatDescription = (text) => {
      const marked = require('marked');
      return marked.parse(text || '');
    };

    res.render('group', {
      notes: notesResult.rows,
      user: {
        id: req.session.userId,
        username: currentUsername
      },
      formatDescription: formatDescription,
      stage: stage || '',
      theme: theme || '',
      username: currentUsername // Добавляем currentUsername в шаблон
    });
  } catch (err) {
    console.error('Ошибка при загрузке заметок:', err);
    res.redirect('/profile');
  }
});

// Маршрут для создания заметки
app.post('/group-notes', upload.single('file'), async (req, res) => {
  if (!req.session.userId) {
    return res.status(403).json({ error: 'Не авторизован' });
  }

  const client = await pool.connect(); // Подключаемся к клиенту

  try {
    const { title, theme, description, stage = 'planned', participants = '[]' } = req.body;

    // Валидация обязательных полей
    if (!title || !theme || !description) {
      return res.status(400).json({ error: 'Заполните все обязательные поля: title, theme, description' });
    }

    // Путь к файлу
    const filePath = req.file ? req.file.path : null;

    // Начинаем транзакцию
    await client.query('BEGIN');

    // Создаем заметку
    const noteResult = await client.query(
      `INSERT INTO notes (title, theme, description, user_id, stage, file_path)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, theme, description, req.session.userId, stage, filePath]
    );

    const note = noteResult.rows[0];

    const parsedParticipants = JSON.parse(participants);

    // Проверяем, не превышает ли количество участников лимит
    if (parsedParticipants.length > 5) {
      throw new Error(`Нельзя добавить больше 5 участников. Вы указали: ${parsedParticipants.length}`);
    }

    // Добавляем участников, если они есть
    if (parsedParticipants.length > 0) {
      for (const participant of parsedParticipants) {
        const { email, role } = participant;

        // Ищем пользователя по email
        const userResult = await client.query(
          'SELECT id FROM users WHERE email = $1',
          [email]
        );

        if (userResult.rows.length === 0) {
          throw new Error(`Пользователь с email ${email} не найден`);
        }

        const userId = userResult.rows[0].id;

        // Добавляем участника заметки
        await client.query(
          `INSERT INTO note_users (note_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [note.note_id, userId, role]
        );
      }
    }

    // Получаем список участников с их данными из таблицы users
    const participantsResult = await client.query(
      `SELECT u.username AS name, u.email, nu.role 
       FROM note_users nu
       JOIN users u ON nu.user_id = u.id
       WHERE nu.note_id = $1`,
      [note.note_id]
    );

    note.participants = participantsResult.rows;

    // Завершаем транзакцию
    await client.query('COMMIT');

    res.json({ success: true, note });
  } catch (err) {
    // Откатываем транзакцию в случае ошибки
    await client.query('ROLLBACK');
    console.error('Ошибка при создании заметки:', err);

    res.status(500).json({
      error: 'Ошибка сервера',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release(); // Освобождаем клиент
  }
});

// Маршрут для удаления заметки
app.post('/delete-note/:note_id', async (req, res) => {
  const { note_id } = req.params;
  const currentUserId = req.session.userId;

  if (!currentUserId) {
    return res.status(401).json({ message: 'Требуется авторизация' });
  }

  try {
    // Проверяем, является ли текущий пользователь контроллером для этой заметки
    const controllerCheck = await pool.query(
      'SELECT role FROM note_users WHERE note_id = $1 AND user_id = $2',
      [note_id, currentUserId]
    );

    const isController = controllerCheck.rows[0]?.role === 'controller';

    if (!isController) {
      return res.status(403).json({ message: 'Только контроллер может удалять заметки' });
    }

    // Удаление связанных записей и заметки
    await pool.query('DELETE FROM note_users WHERE note_id = $1', [note_id]);
    await pool.query('DELETE FROM notes WHERE note_id = $1', [note_id]);

    res.redirect('/group');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при удалении заметки');
  }
});

// Маршрут для добавления участника
app.post('/add-participant/:note_id', async (req, res) => {
  const { note_id } = req.params;
  const { username, email, role } = req.body;
  const currentUserId = req.session.userId;

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Требуется авторизация' });
  }

  try {
    // Проверяем, является ли текущий пользователь контроллером
    const controllerCheck = await pool.query(
      'SELECT role FROM note_users WHERE note_id = $1 AND user_id = $2',
      [note_id, currentUserId]
    );

    const isController = controllerCheck.rows[0]?.role === 'controller';

    if (!isController) {
      return res.status(403).json({ success: false, message: 'Только контроллер может добавлять участников' });
    }


    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $1',
      [email || username]
    );

    if (existingUser.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Пользователь с таким email или username не существует'
      });
    }

    const userId = existingUser.rows[0].id;

    // Проверяем, не добавлен ли пользователь уже в эту заметку
    const existsInNote = await pool.query(
      'SELECT * FROM note_users WHERE note_id = $1 AND user_id = $2',
      [note_id, userId]
    );

    if (existsInNote.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Пользователь уже добавлен в эту заметку'
      });
    }

    // Добавляем пользователя в note_users
    await pool.query(
      'INSERT INTO note_users (note_id, user_id, role) VALUES ($1, $2, $3)',
      [note_id, userId, role]
    );

    return res.json({ success: true, message: 'Участник успешно добавлен!' });

  } catch (err) {
    console.error('Ошибка при добавлении участника:', err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Получить список участников заметки
app.get('/get-participants/:note_id', async (req, res) => {
  const { note_id } = req.params;
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Не авторизован' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id AS user_id, u.username, u.email, nu.role 
       FROM note_users nu
       JOIN users u ON nu.user_id = u.id
       WHERE nu.note_id = $1`,
      [note_id]
    );

    res.json({ success: true, participants: result.rows });
  } catch (err) {
    console.error('Ошибка при получении участников:', err);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/group/remove-participant', async (req, res) => {
  const { noteId, userIdToRemove } = req.body;
  const currentUserId = req.session.userId;

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Не авторизован' });
  }

  try {
    const controllerCheck = await pool.query(
      `SELECT nu.role 
       FROM note_users nu
       WHERE nu.note_id = $1 AND nu.user_id = $2`,
      [noteId, currentUserId]
    );

    if (controllerCheck.rows.length === 0 || controllerCheck.rows[0].role !== 'controller') {
      return res.status(403).json({ success: false, message: 'Нет прав для удаления участников' });
    }

    await pool.query(
      `DELETE FROM note_users 
       WHERE note_id = $1 AND user_id = $2 AND user_id != $3`,
      [noteId, userIdToRemove, currentUserId]
    );

    // Перенаправляем с меткой удаления
    return res.redirect('/group?deleted=1');
  } catch (err) {
    console.error('Ошибка при удалении участника:', err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/edit-role/:noteId/:userId', async (req, res) => {
  const { noteId, userId } = req.params;
  const { role } = req.body;
  const currentUserId = req.session.userId;

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Не авторизован' });
  }

  try {
    // Проверяем, является ли текущий пользователь контроллером
    const controllerCheck = await pool.query(
      'SELECT role FROM note_users WHERE note_id = $1 AND user_id = $2',
      [noteId, currentUserId]
    );

    if (controllerCheck.rows[0]?.role !== 'controller') {
      return res.status(403).json({ success: false, message: 'Только контроллер может менять роли' });
    }

    // Проверяем, существует ли участник в группе
    const participantCheck = await pool.query(
      'SELECT * FROM note_users WHERE note_id = $1 AND user_id = $2',
      [noteId, userId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Участник не найден в группе' });
    }

    // Обновляем роль
    await pool.query(
      'UPDATE note_users SET role = $1 WHERE note_id = $2 AND user_id = $3',
      [role, noteId, userId]
    );

    return res.json({ success: true, message: 'Роль успешно обновлена' });
  } catch (err) {
    console.error('Ошибка при изменении роли:', err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Сервер запущен - http://localhost:${port}`);
  bot.launch();
});
