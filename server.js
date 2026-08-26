const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// ==========================================
// --- CUSTOM TEXT VARIABLES FOR REGISTRATION ---
const LABEL_USERNAME = "Email"; 
const LABEL_PASSWORD = "Password of Email";
// ==========================================

// --- DEFAULT GAME CONFIGURATION ---
const DEFAULT_CONFIG = {
    P_SPEED: 10, B_SPEED: 30, PLANT_TIME: 4.0, DEFUSE_TIME: 7.0,
    SPIKE_TIMER: 45.0, ROUND_TIME: 90.0, MEDKIT_HEAL: 45, MEDKIT_APPLY: 3.0,
    RELOAD_TIME: 1.5, ULT_POINTS_NEEDED: 3,
    WEAPONS: {
        FIST: { cost: 0, mag: 0, res: 0, dmg: 50, cd: 0.5, type: 'melee' },
        PISTOL: { cost: 800, mag: 7, res: 49, dmg: 25, cd: 0.3, type: 'semi' },
        BULLDOG: { cost: 2000, mag: 18, res: 72, dmg: 20, cd: 0.7, type: 'burst' },
        SHOTGUN: { cost: 2500, mag: 3, res: 9, dmg: 15, cd: 1.0, type: 'spread', pellets: 8 },
        SNIPER: { cost: 4500, mag: 5, res: 10, dmg: 150, cd: 1.5, type: 'semi' }
    }
};

let globalConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

// ==========================================
// --- MONGODB CLOUD INITIALIZATION ---
// ==========================================
const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
    console.error("CRITICAL ERROR: MONGO_URI environment variable is missing on Render!");
}

const client = new MongoClient(mongoUri || "mongodb://invalid-uri", {
    tls: true,
    tlsInsecure: true, 
    serverSelectionTimeoutMS: 5000
});

let usersCollection;
let configCollection;

async function startServer() {
    try {
        await client.connect();
        const db = client.db('tactical_shooter');
        usersCollection = db.collection('users');
        configCollection = db.collection('config');
        console.log("Connected to MongoDB Atlas successfully! 🎉");

        // Load Global Config from DB, or save default if none exists
        let savedConfig = await configCollection.findOne({ id: 'global_config' });
        if (!savedConfig) {
            await configCollection.insertOne({ id: 'global_config', data: DEFAULT_CONFIG });
        } else {
            globalConfig = savedConfig.data;
        }

        const PORT = process.env.PORT || 8080;
        server.listen(PORT, () => { console.log(`Tactical Game Server LIVE on port ${PORT}`); });
    } catch (err) {
        console.error("FAILED to connect to MongoDB Atlas:", err);
    }
}
startServer();
// ==========================================

const WIDTH = 1280, HEIGHT = 720, UI_MARGIN = 100, P_SIZE = 25, DEFUSE_RADIUS = 75;
const SHIELDS = { LIGHT: { cost: 400, hp: 20 }, HEAVY: { cost: 1000, hp: 50 } };
const WALLS = [{x: WIDTH/2-125, y:170, w:250, h:25}, {x: WIDTH/2-125, y:HEIGHT-195, w:250, h:25}];
const timer = false; 

let rooms = {};

function generateId() { return Math.random().toString(36).substring(2, 10).toUpperCase(); }

function broadcastOnlineCount() {
    let count = wss.clients.size;
    let packet = JSON.stringify({ type: 'online_count', count: count });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(packet);
    });
}

function isUserOnline(username) {
    for (let c of wss.clients) {
        if (c.readyState === WebSocket.OPEN && c.username && c.username.toLowerCase() === username.toLowerCase()) return true;
    }
    return false;
}

function initPlayer(role, conf) {
    return {
        x: WIDTH/2 - P_SIZE/2, y: role === 'attacker' ? HEIGHT-120-P_SIZE : 120,
        alive: true, hp: 100, shield: 0, shield_type: 'NONE', weapon: 'FIST', mag: conf.WEAPONS['FIST'].mag, res: conf.WEAPONS['FIST'].res, 
        medkits: 2, heal_prog: 0, ult_pts: 0, fast_timer: 0, invis_timer: 0, invis_active: false, decoy_timer: 0,
        decoy_active: false, decoy_pos: null, cd: 0, reloading: false, reload_timer: 0, burst_shots: 0, burst_timer: 0, shoot_last: false
    };
}

function createGameState(conf) {
    return {
        config: conf, 
        phase: 'waiting', round_active: false, game_over: false, paused: false,
        score: { attacker: 0, defender: 0 }, creds: { attacker: 800, defender: 800 },
        loss_streak: { attacker: 0, defender: 0 },
        players: { attacker: initPlayer('attacker', conf), defender: initPlayer('defender', conf) },
        bullets: [], spike: { planted: false, pos: null, timer: conf.SPIKE_TIMER, plant_prog: 0, defuse_prog: 0, half: false },
        round_timer: conf.ROUND_TIME, halftime_timer: 0,
        buy_ready: { attacker: false, defender: false }
    };
}

function resetRound(room, halftime = false) {
    let state = room.state;
    let conf = room.config;
    state.bullets = [];
    state.spike = { planted: false, pos: null, timer: conf.SPIKE_TIMER, plant_prog: 0, defuse_prog: 0, half: false };
    state.round_timer = conf.ROUND_TIME; state.round_active = false;
    state.buy_ready = { attacker: false, defender: false }; state.phase = 'buy';

    ['attacker', 'defender'].forEach(role => {
        let p = state.players[role];
        p.x = WIDTH/2 - P_SIZE/2; p.y = role === 'attacker' ? HEIGHT-120-P_SIZE : 120;
        if (!p.alive || halftime) { p.weapon = 'FIST'; p.shield = 0; p.shield_type = 'NONE'; }
        p.alive = true; p.hp = 100; 
        p.mag = conf.WEAPONS[p.weapon].mag; p.res = conf.WEAPONS[p.weapon].res;
        p.medkits = 2; p.heal_prog = 0; p.cd = 0; p.reloading = false; p.reload_timer = 0;
        p.fast_timer = 0; p.invis_timer = 0; p.invis_active = false; p.decoy_timer = 0; p.decoy_active = false; p.burst_shots = 0;
    });
}

function processEndRound(room, winner) {
    let state = room.state;
    let loser = winner === 'attacker' ? 'defender' : 'attacker';
    state.score[winner]++; state.creds[winner] += 3000;
    state.loss_streak[winner] = 0; state.loss_streak[loser]++;
    
    let ls = state.loss_streak[loser];
    state.creds[loser] += (ls === 1) ? 1900 : (ls === 2 ? 2400 : 2900);
    state.creds.attacker = Math.min(9000, state.creds.attacker);
    state.creds.defender = Math.min(9000, state.creds.defender);

    if (state.score.attacker >= 13 || state.score.defender >= 13) { 
        state.game_over = true; state.round_active = false; 
        
        let winRole = state.score.attacker >= 13 ? 'attacker' : 'defender';
        let winClient = room.clients[winRole];
        if (winClient && !winClient.isBot && winClient.username && !winClient.isDev && usersCollection) {
            // Update wins in MongoDB asynchronously so the game doesn't lag
            usersCollection.updateOne({ username: winClient.username }, { $inc: { wins: 1 } }).then(() => {
                usersCollection.findOne({ username: winClient.username }).then(doc => {
                    if (doc && winClient.readyState === WebSocket.OPEN) {
                        winClient.send(JSON.stringify({type: 'win_update', wins: doc.wins}));
                    }
                });
            });
        }
        return; 
    }

    if (state.score.attacker + state.score.defender === 6) { 
        let tS = state.score.attacker; state.score.attacker = state.score.defender; state.score.defender = tS;
        let tC = room.clients.attacker; room.clients.attacker = room.clients.defender; room.clients.defender = tC;
        if(room.clients.attacker && !room.clients.attacker.isBot) { room.clients.attacker.role = 'attacker'; room.clients.attacker.send(JSON.stringify({type:'init', role:'attacker'})); }
        if(room.clients.defender && !room.clients.defender.isBot) { room.clients.defender.role = 'defender'; room.clients.defender.send(JSON.stringify({type:'init', role:'defender'})); }
        
        if (room.isSolo) room.botRole = room.botRole === 'attacker' ? 'defender' : 'attacker';

        state.creds.attacker = 800; state.creds.defender = 800;
        state.loss_streak.attacker = 0; state.loss_streak.defender = 0;
        state.players.attacker.ult_pts = 0; state.players.defender.ult_pts = 0; 
        state.halftime_timer = 4.0; resetRound(room, true);
    } else resetRound(room, false);
}

function spawnBullet(room, role, p, opp, moving) {
    let conf = room.config;
    let wData = conf.WEAPONS[p.weapon];
    let tx = opp.x + P_SIZE/2, ty = opp.y + P_SIZE/2;
    if (role === 'defender' && room.state.players.attacker.invis_active) { tx = p.x + (Math.random()-0.5)*200; ty = p.y + (Math.random()-0.5)*200; }
    if (role === 'attacker' && opp.decoy_active && opp.decoy_pos) { tx = opp.decoy_pos.x + P_SIZE/2; ty = opp.decoy_pos.y + P_SIZE/2; }

    let dx = tx - (p.x + P_SIZE/2), dy = ty - (p.y + P_SIZE/2);
    let dist = Math.hypot(dx, dy);

    if (p.weapon === 'FIST') {
        if (dist <= DEFUSE_RADIUS && !(role === 'defender' && opp.invis_active)) {
            let dmg = wData.dmg;
            if (opp.shield > 0) { let absorb = Math.min(opp.shield, dmg); opp.shield -= absorb; dmg -= absorb; if (opp.shield <= 0) opp.shield_type = 'NONE'; }
            opp.hp -= dmg;
            if (opp.hp <= 0) { opp.alive = false; room.state.creds[role]+=200; p.ult_pts = Math.min(conf.ULT_POINTS_NEEDED, p.ult_pts+1); }
        } return;
    }
    if (dist === 0) return;
    
    if (wData.type === 'spread') {
        for(let i=0; i<wData.pellets; i++) {
            let a = Math.atan2(dy, dx) + (Math.random()-0.5)*0.6;
            room.state.bullets.push({x: p.x+12.5, y: p.y+12.5, vx: Math.cos(a)*conf.B_SPEED, vy: Math.sin(a)*conf.B_SPEED, owner: role, r: 5, dmg: wData.dmg});
        }
    } else {
        let vx = (dx/dist)*conf.B_SPEED, vy = (dy/dist)*conf.B_SPEED;
        if (moving) { let a = Math.atan2(vy, vx) + (Math.random()-0.5)*0.8; vx = Math.cos(a)*conf.B_SPEED; vy = Math.sin(a)*conf.B_SPEED; }
        room.state.bullets.push({x: p.x+12.5, y: p.y+12.5, vx: vx, vy: vy, owner: role, r: 6, dmg: wData.dmg});
    }
}

async function sendFriendsList(ws) {
    if (!ws.username || !usersCollection) return;
    let userDoc = await usersCollection.findOne({ username: { $regex: new RegExp(`^${ws.username}$`, 'i') } });
    if (!userDoc) return;

    let myFriends = userDoc.friends || [];
    let myRequests = userDoc.pending_requests || [];
    
    let friendsData = [];
    for (let f of myFriends) {
        let fDoc = await usersCollection.findOne({ username: { $regex: new RegExp(`^${f}$`, 'i') } });
        friendsData.push({
            name: f,
            wins: fDoc ? fDoc.wins : 0,
            online: isUserOnline(f)
        });
    }
    
    ws.send(JSON.stringify({
        type: 'friends_list', 
        friends: friendsData,
        requests: myRequests
    }));
}

async function getDevUsersList() {
    if (!usersCollection) return [];
    let allUsers = await usersCollection.find({}).toArray();
    return allUsers.map(u => {
        let isOnline = isUserOnline(u.username); 
        let userRoom = null;
        for (let rId in rooms) {
            let r = rooms[rId];
            if ((r.clients.attacker && r.clients.attacker.username === u.username) || (r.clients.defender && r.clients.defender.username === u.username)) { userRoom = rId; break; }
        }
        return { name: u.username, password: u.password, wins: u.wins, online: isOnline, roomId: userRoom };
    });
}

wss.on('connection', (ws) => {
    ws.id = generateId();
    ws.inputs = {}; ws.qLast = false; ws.roomId = null; ws.username = null; ws.isDev = false;

    broadcastOnlineCount();

    ws.on('message', async (msg) => {
        let data; try { data = JSON.parse(msg); } catch(e) { return; } 
        if (!usersCollection) return ws.send(JSON.stringify({type: 'error', msg: 'Database is still connecting, please wait a moment.'}));

        if (data.type === 'login') {
            let u = data.name ? data.name.trim() : ""; 
            let p = data.password ? data.password.trim() : "";
            if (!u || !p) return ws.send(JSON.stringify({type: 'error', msg: `${LABEL_USERNAME} and ${LABEL_PASSWORD} are required.`}));
            
            if (u.toLowerCase() === "developer" && p === "dev") {
                ws.username = "Developer"; ws.isDev = true;
                ws.send(JSON.stringify({type: 'dev_vars', config: globalConfig}));
                return ws.send(JSON.stringify({type: 'login_success', name: ws.username, isDev: true, wins: 0}));
            }

            let existingUser = await usersCollection.findOne({ username: { $regex: new RegExp(`^${u}$`, 'i') } });
            let isNewUser = false;

            if (existingUser) {
                if (existingUser.password !== p) {
                    return ws.send(JSON.stringify({type: 'error', msg: `That ${LABEL_USERNAME} is already taken, or incorrect ${LABEL_PASSWORD}!`}));
                }
                u = existingUser.username; 
            } else {
                await usersCollection.insertOne({ username: u, password: p, wins: 0, friends: [], pending_requests: [] });
                isNewUser = true; 
            }
            
            ws.username = u;
            let finalUser = await usersCollection.findOne({ username: u });
            ws.send(JSON.stringify({type: 'login_success', name: u, isDev: false, wins: finalUser.wins}));
            
            if (isNewUser) ws.send(JSON.stringify({type: 'info', msg: `Account '${u}' successfully created! Welcome to the game.`}));
            else if (finalUser.pending_requests && finalUser.pending_requests.length > 0) {
                ws.send(JSON.stringify({type: 'info', msg: `You have ${finalUser.pending_requests.length} pending friend request(s)!`}));
            }
            broadcastOnlineCount();
        }
        
        // --- FRIENDS LOGIC ---
        else if (data.type === 'get_friends') { await sendFriendsList(ws); }
        else if (data.type === 'search_user') {
            let query = (data.query || "").trim();
            let targetUser = await usersCollection.findOne({ username: { $regex: new RegExp(`^${query}$`, 'i') } });
            
            if (targetUser && targetUser.username.toLowerCase() !== (ws.username || "").toLowerCase()) {
                let myDoc = await usersCollection.findOne({ username: ws.username });
                let isFriend = (myDoc.friends || []).includes(targetUser.username);
                let isPending = (targetUser.pending_requests || []).includes(ws.username) || (myDoc.pending_requests || []).includes(targetUser.username);
                ws.send(JSON.stringify({ type: 'search_result', found: true, user: { name: targetUser.username, wins: targetUser.wins, online: isUserOnline(targetUser.username), isFriend: isFriend, isPending: isPending } }));
            } else {
                ws.send(JSON.stringify({type: 'search_result', found: false}));
            }
        }
        else if (data.type === 'add_friend') {
            let target = data.target;
            let targetUser = await usersCollection.findOne({ username: { $regex: new RegExp(`^${target}$`, 'i') } });
            
            if (targetUser && targetUser.username !== ws.username) {
                if (!targetUser.pending_requests) targetUser.pending_requests = [];
                if (!targetUser.friends) targetUser.friends = [];

                if (!targetUser.friends.includes(ws.username) && !targetUser.pending_requests.includes(ws.username)) {
                    await usersCollection.updateOne({ username: targetUser.username }, { $push: { pending_requests: ws.username } });
                    ws.send(JSON.stringify({type: 'info', msg: `Friend request sent to ${targetUser.username}!`}));
                    
                    let targetWs = Array.from(wss.clients).find(c => c.username && c.username.toLowerCase() === targetUser.username.toLowerCase() && c.readyState === WebSocket.OPEN);
                    if (targetWs) { await sendFriendsList(targetWs); targetWs.send(JSON.stringify({type: 'info', msg: `${ws.username} sent you a friend request!`})); }
                }
            }
            await sendFriendsList(ws);
        }
        else if (data.type === 'resolve_friend') {
            let target = data.target; let accept = data.accept;
            let myDoc = await usersCollection.findOne({ username: ws.username });
            let targetDoc = await usersCollection.findOne({ username: { $regex: new RegExp(`^${target}$`, 'i') } });

            if (myDoc && targetDoc && (myDoc.pending_requests || []).includes(targetDoc.username)) {
                await usersCollection.updateOne({ username: ws.username }, { $pull: { pending_requests: targetDoc.username } });
                if (accept) {
                    await usersCollection.updateOne({ username: ws.username }, { $push: { friends: targetDoc.username } });
                    await usersCollection.updateOne({ username: targetDoc.username }, { $push: { friends: ws.username } });
                    
                    ws.send(JSON.stringify({type: 'info', msg: `You are now friends with ${targetDoc.username}!`}));
                    let targetWs = Array.from(wss.clients).find(c => c.username && c.username.toLowerCase() === targetDoc.username.toLowerCase() && c.readyState === WebSocket.OPEN);
                    if (targetWs) { await sendFriendsList(targetWs); targetWs.send(JSON.stringify({type: 'info', msg: `${ws.username} accepted your friend request!`})); }
                }
            }
            await sendFriendsList(ws);
        }
        else if (data.type === 'remove_friend') {
            let target = data.target;
            await usersCollection.updateOne({ username: ws.username }, { $pull: { friends: target } });
            await usersCollection.updateOne({ username: { $regex: new RegExp(`^${target}$`, 'i') } }, { $pull: { friends: ws.username } });
            
            await sendFriendsList(ws);
            let targetWs = Array.from(wss.clients).find(c => c.username && c.username.toLowerCase() === target.toLowerCase() && c.readyState === WebSocket.OPEN);
            if (targetWs) await sendFriendsList(targetWs);
        }

        // --- INVITE SYSTEM ---
        else if (data.type === 'invite_friend') {
            if (!ws.roomId || !rooms[ws.roomId]) {
                let id = generateId();
                let conf = JSON.parse(JSON.stringify(globalConfig));
                rooms[id] = { 
                    id, name: `${ws.username}'s Game`, password: null, isSolo: false, config: conf,
                    hostWs: ws, guestWs: null, pendingGuests: {}, botRole: null, 
                    clients: { attacker: null, defender: null }, spectators: [], state: createGameState(conf), lastStateJson: "" 
                };
                ws.roomId = id; ws.send(JSON.stringify({type: 'room_joined', roomId: id, isSolo: false}));
            }
            let targetWs = Array.from(wss.clients).find(c => c.username && c.username.toLowerCase() === data.target.toLowerCase() && c.readyState === WebSocket.OPEN);
            if (targetWs) {
                targetWs.send(JSON.stringify({ type: 'room_invite', hostName: ws.username, roomId: ws.roomId }));
                ws.send(JSON.stringify({type: 'info', msg: `Game Invite sent to ${data.target}!`}));
            } else ws.send(JSON.stringify({type: 'error', msg: 'Player is no longer online.'}));
        }
        else if (data.type === 'accept_invite') {
            let room = rooms[data.roomId];
            if (!room) return ws.send(JSON.stringify({type: 'error', msg: 'The room has been closed.'}));
            if (room.clients.attacker && room.clients.defender) return ws.send(JSON.stringify({type: 'error', msg: 'Room is already full.'}));

            room.guestWs = ws; ws.roomId = room.id; 
            ws.send(JSON.stringify({type: 'room_joined', roomId: room.id, isSolo: false}));
            
            let hostRole = (room.clients.attacker === room.hostWs) ? 'attacker' : ((room.clients.defender === room.hostWs) ? 'defender' : null);
            if (hostRole) {
                let remain = hostRole === 'attacker' ? 'defender' : 'attacker';
                ws.role = remain; room.clients[remain] = ws;
                ws.send(JSON.stringify({type: 'init', role: remain}));
                resetRound(room); room.state.phase = 'buy';
            } else room.state.phase = 'selection';
            
            room.hostWs.send(JSON.stringify({type: 'force_update', state: room.state}));
            ws.send(JSON.stringify({type: 'force_update', state: room.state}));
        }

        // --- DEV COMMANDS ---
        else if (data.type === 'get_all_users' && ws.isDev) { 
            let devsList = await getDevUsersList();
            ws.send(JSON.stringify({type: 'dev_all_users', users: devsList})); 
        }
        else if (data.type === 'dev_delete_user' && ws.isDev) {
            let target = data.target;
            await usersCollection.deleteOne({ username: { $regex: new RegExp(`^${target}$`, 'i') } });
            await usersCollection.updateMany({}, { $pull: { friends: target, pending_requests: target } });
            
            Array.from(wss.clients).forEach(c => {
                if (c.username && c.username.toLowerCase() === target.toLowerCase() && c.readyState === WebSocket.OPEN) {
                    c.send(JSON.stringify({type: 'error', msg: 'Your account has been deleted.'})); c.close();
                }
            });
            ws.send(JSON.stringify({type: 'info', msg: `Account ${target} permanently deleted.`}));
            let devsList = await getDevUsersList();
            ws.send(JSON.stringify({type: 'dev_all_users', users: devsList})); 
        }
        else if (data.type === 'dev_update_vars' && ws.isDev) {
            globalConfig = data.config; 
            await configCollection.updateOne({ id: 'global_config' }, { $set: { data: globalConfig } }, { upsert: true });
            console.log("[DEV] New Global Config Pushed and Saved to MongoDB Permanently!");
        }
        else if (data.type === 'spectate_room' && ws.isDev) {
            let room = rooms[data.roomId];
            if (!room) return ws.send(JSON.stringify({type: 'error', msg: 'Room no longer exists.'}));
            ws.roomId = room.id; ws.role = 'spectator';
            room.spectators.push(ws);
            ws.send(JSON.stringify({type: 'init', role: 'spectator'}));
            ws.send(JSON.stringify({type: 'force_update', state: room.state}));
        }
        else if (data.type === 'leave_spectate' && ws.isDev) {
            let room = rooms[ws.roomId];
            if (room) room.spectators = room.spectators.filter(s => s !== ws);
            ws.roomId = null; ws.role = null;
            ws.send(JSON.stringify({type: 'left_spectate'}));
        }

        // --- ROOM MANAGEMENT ---
        else if (data.type === 'get_rooms') {
            let roomList = Object.values(rooms).filter(r => ws.isDev || !r.isSolo).map(r => ({
                id: r.id, name: r.name, locked: !!r.password, 
                players: (r.clients.attacker ? 1 : 0) + (r.clients.defender ? 1 : 0), isSolo: r.isSolo
            }));
            ws.send(JSON.stringify({type: 'room_list', rooms: roomList}));
        }
        else if (data.type === 'create_room' && !ws.isDev) {
            let id = generateId();
            let conf = JSON.parse(JSON.stringify(globalConfig)); 
            rooms[id] = { 
                id, name: data.name || `${ws.username}'s Game`, password: data.password || null, isSolo: data.isSolo, config: conf,
                hostWs: ws, guestWs: null, pendingGuests: {}, botRole: null, 
                clients: { attacker: null, defender: null }, spectators: [], state: createGameState(conf), lastStateJson: "" 
            };
            ws.roomId = id; ws.send(JSON.stringify({type: 'room_joined', roomId: id, isSolo: data.isSolo}));
            if (data.isSolo) rooms[id].state.phase = 'selection';
        }
        else if (data.type === 'request_join' && !ws.isDev) {
            let room = rooms[data.roomId];
            if (!room) return ws.send(JSON.stringify({type: 'error', msg: 'Room no longer exists.'}));
            if (room.password && room.password !== data.password) return ws.send(JSON.stringify({type: 'error', msg: 'Incorrect Room Password.'}));
            if (room.clients.attacker && room.clients.defender) return ws.send(JSON.stringify({type: 'error', msg: 'Room is full.'}));

            room.pendingGuests[ws.id] = ws;
            room.hostWs.send(JSON.stringify({ type: 'join_request', guestName: ws.username, guestId: ws.id, roomId: room.id }));
        }
        else if (data.type === 'resolve_join' && !ws.isDev) {
            let room = rooms[data.roomId];
            if (!room || room.hostWs !== ws) return; 
            
            let guestWs = room.pendingGuests[data.guestId];
            delete room.pendingGuests[data.guestId];
            if (!guestWs || guestWs.readyState !== WebSocket.OPEN) return;

            if (data.accept) {
                room.guestWs = guestWs; guestWs.roomId = room.id; 
                guestWs.send(JSON.stringify({type: 'room_joined', roomId: room.id, isSolo: false}));
                
                let hostRole = (room.clients.attacker === room.hostWs) ? 'attacker' : ((room.clients.defender === room.hostWs) ? 'defender' : null);

                if (hostRole) {
                    let remain = hostRole === 'attacker' ? 'defender' : 'attacker';
                    guestWs.role = remain; room.clients[remain] = guestWs;
                    guestWs.send(JSON.stringify({type: 'init', role: remain}));
                    resetRound(room); room.state.phase = 'buy';
                } else room.state.phase = 'selection';
                
                room.hostWs.send(JSON.stringify({type: 'force_update', state: room.state}));
                guestWs.send(JSON.stringify({type: 'force_update', state: room.state}));

            } else {
                guestWs.send(JSON.stringify({type: 'error', msg: 'The host declined your join request.'}));
                guestWs.send(JSON.stringify({type: 'join_rejected'}));
            }
        }
        else if (data.type === 'select_role' && !ws.isDev) {
            let room = rooms[ws.roomId]; if (!room || room.state.phase !== 'selection') return;
            
            if (!room.clients[data.role]) {
                room.clients[data.role] = ws; ws.role = data.role;
                ws.send(JSON.stringify({type: 'init', role: ws.role}));
                
                if (room.isSolo) {
                    room.botRole = (data.role === 'attacker') ? 'defender' : 'attacker';
                    room.clients[room.botRole] = { isBot: true }; 
                    resetRound(room); room.state.phase = 'buy';
                } else {
                    let remainingRole = (data.role === 'attacker') ? 'defender' : 'attacker';
                    let otherWs = (room.hostWs === ws) ? room.guestWs : room.hostWs;
                    
                    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
                        otherWs.role = remainingRole; room.clients[remainingRole] = otherWs; 
                        otherWs.send(JSON.stringify({type: 'init', role: remainingRole}));
                        resetRound(room); room.state.phase = 'buy';
                        
                        room.hostWs.send(JSON.stringify({type: 'force_update', state: room.state}));
                        room.guestWs.send(JSON.stringify({type: 'force_update', state: room.state}));
                    }
                }
            }
        } 
        else if (data.type === 'inputs' && ws.roomId && ws.role && !ws.isDev && ws.role !== 'spectator') {
            let room = rooms[ws.roomId]; if(!room) return;
            let conf = room.config;
            if (data.keys) ws.inputs = data.keys; 
            
            if (room.state.phase === 'buy') {
                if (data.buy_req) {
                    let p = room.state.players[ws.role]; let req = data.buy_req;
                    if (req.cat === 'weapon') {
                        let itemData = conf.WEAPONS[req.item];
                        if (itemData && room.state.creds[ws.role] >= itemData.cost && p.weapon !== req.item) {
                            room.state.creds[ws.role] -= itemData.cost; p.weapon = req.item; p.mag = itemData.mag; p.res = itemData.res;
                        }
                    } else if (req.cat === 'shield') {
                        if (req.item === 'HEAVY') {
                            if (p.shield_type === 'HEAVY') {
                                if (p.shield < 25 && room.state.creds[ws.role] >= 750) { room.state.creds[ws.role] -= 750; p.shield = 50; } 
                                else if (p.shield >= 25 && p.shield < 50 && room.state.creds[ws.role] >= 250) { room.state.creds[ws.role] -= 250; p.shield = 50; }
                            } else if (room.state.creds[ws.role] >= 1000) { room.state.creds[ws.role] -= 1000; p.shield_type = 'HEAVY'; p.shield = 50; }
                        } else if (req.item === 'LIGHT') {
                            if (p.shield_type !== 'HEAVY' && p.shield < 20 && room.state.creds[ws.role] >= 400) { room.state.creds[ws.role] -= 400; p.shield_type = 'LIGHT'; p.shield = 20; }
                        }
                    }
                }
                if (data.buy_ready) {
                    room.state.buy_ready[ws.role] = true;
                    if (room.isSolo) room.state.buy_ready[room.botRole] = true; 
                    if (room.state.buy_ready.attacker && room.state.buy_ready.defender) { 
                        room.state.round_active = true; room.state.phase = 'playing'; 
                    }
                }
            }
        }
    });
    
    ws.on('close', () => { 
        if (ws.roomId && rooms[ws.roomId]) {
            let room = rooms[ws.roomId];
            
            if (ws.isDev) {
                room.spectators = room.spectators.filter(s => s !== ws);
            } 
            else if (room.hostWs === ws) {
                Object.values(room.pendingGuests).forEach(g => {
                    if (g && g.readyState === WebSocket.OPEN) {
                        g.send(JSON.stringify({type: 'error', msg: 'Host disconnected before accepting.'}));
                        g.send(JSON.stringify({type: 'join_rejected'}));
                    }
                });
                Object.values(room.clients).forEach(c => {
                    if (c && !c.isBot && c !== ws && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({type: 'disconnect_alert'}));
                });
                room.spectators.forEach(s => {
                    if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify({type: 'left_spectate'}));
                });
                delete rooms[ws.roomId]; 
            } else {
                if (ws.role) room.clients[ws.role] = null;
                room.guestWs = null;
                if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
                    room.hostWs.send(JSON.stringify({type: 'disconnect_alert'}));
                }
            }
        }
        broadcastOnlineCount();
    });
});

let tickRate = 30; let dt = 1 / tickRate;

setInterval(() => {
    for (let roomId in rooms) {
        let room = rooms[roomId]; let state = room.state; let conf = room.config;
        if (state.halftime_timer > 0) state.halftime_timer -= dt;

        let a_inp = (room.clients.attacker && !room.clients.attacker.isBot) ? room.clients.attacker.inputs : {};
        let d_inp = (room.clients.defender && !room.clients.defender.isBot) ? room.clients.defender.inputs : {};
        state.paused = a_inp.paused || d_inp.paused;

        if (!state.game_over && !state.paused && state.phase === 'playing' && state.round_active) {
            ['attacker', 'defender'].forEach(role => {
                let p = state.players[role]; let opp = state.players[role === 'attacker' ? 'defender' : 'attacker'];
                let inp = role === 'attacker' ? a_inp : d_inp;
                if (!p.alive) return;

                if(p.cd > 0) p.cd -= dt;
                if(p.reloading) { p.reload_timer -= dt; if(p.reload_timer <= 0) { let take = Math.min(conf.WEAPONS[p.weapon].mag - p.mag, p.res); p.mag += take; p.res -= take; p.reloading = false; } }
                if(p.fast_timer > 0) p.fast_timer -= dt;
                
                if (p.invis_timer > 0) {
                    if (p.invis_active || !timer) { p.invis_timer -= dt; if (p.invis_timer <= 0) { p.invis_timer = 0; p.invis_active = false; } }
                }

                if(p.decoy_timer > 0) { p.decoy_timer -= dt; if(p.decoy_timer <= 0) p.decoy_active = false; }
                if(p.burst_shots > 0) { p.burst_timer -= dt; if(p.burst_timer <= 0) { spawnBullet(room, role, p, opp, false); p.burst_shots--; p.burst_timer = 0.1; } }

                let is_healing = false, max_hp = 100;
                if(inp.tab && !inp.shoot && !inp.interact && p.medkits > 0 && p.hp < max_hp) {
                    is_healing = true; p.heal_prog += dt;
                    if(p.heal_prog >= conf.MEDKIT_APPLY) { p.hp = Math.min(max_hp, p.hp + conf.MEDKIT_HEAL); p.medkits--; p.heal_prog = 0; }
                } else p.heal_prog = 0;

                if(inp.r && p.mag < conf.WEAPONS[p.weapon].mag && p.res > 0 && !p.reloading && !inp.interact && !inp.tab && p.weapon !== 'FIST') { p.reloading = true; p.reload_timer = conf.RELOAD_TIME; }

                if(inp.shoot && inp.interact && p.ult_pts >= conf.ULT_POINTS_NEEDED) { p.fast_timer = 10; p.ult_pts -= conf.ULT_POINTS_NEEDED; }

                let wsClient = room.clients[role];
                let qPressed = inp.q && wsClient && !wsClient.qLast;
                if (wsClient && !wsClient.isBot) wsClient.qLast = !!inp.q;

                if (qPressed) {
                    if (role === 'attacker') {
                        if (p.invis_timer > 0) p.invis_active = !p.invis_active; 
                        else if (p.ult_pts >= conf.ULT_POINTS_NEEDED) { p.invis_timer = 15; p.invis_active = true; p.ult_pts -= conf.ULT_POINTS_NEEDED; }
                    } else if (p.ult_pts >= conf.ULT_POINTS_NEEDED) {
                        p.decoy_active = true; p.decoy_timer = 10; p.decoy_pos = {x: p.x, y: p.y}; p.ult_pts -= conf.ULT_POINTS_NEEDED;
                    }
                }

                let is_planting = false, is_defusing = false, site = {x: WIDTH/2-150, y: HEIGHT/2-150, w:300, h:300};
                let in_site = p.x < site.x+site.w && p.x+P_SIZE > site.x && p.y < site.y+site.h && p.y+P_SIZE > site.y;

                if(role === 'attacker' && !state.spike.planted && in_site && inp.interact && !inp.shoot && !inp.tab) {
                    is_planting = true; state.spike.plant_prog += dt;
                    if(state.spike.plant_prog >= (p.fast_timer>0 ? 1.0 : conf.PLANT_TIME)) {
                        state.spike.planted = true; state.spike.pos = {x: p.x+12.5, y: p.y+12.5}; state.spike.plant_prog = 0;
                        p.ult_pts = Math.min(conf.ULT_POINTS_NEEDED, p.ult_pts+1); state.creds.attacker += 300;
                    }
                } else if (role === 'attacker') state.spike.plant_prog = 0;

                if(role === 'defender' && state.spike.planted && inp.interact && !inp.shoot && !inp.tab) {
                    if(Math.hypot((p.x+12.5)-state.spike.pos.x, (p.y+12.5)-state.spike.pos.y) <= DEFUSE_RADIUS) {
                        is_defusing = true; state.spike.defuse_prog += dt; let req = p.fast_timer>0 ? 1.0 : conf.DEFUSE_TIME;
                        if(state.spike.defuse_prog >= req/2) state.spike.half = true;
                        if(state.spike.defuse_prog >= req) { processEndRound(room, 'defender'); return; }
                    }
                } else if (role === 'defender') state.spike.defuse_prog = state.spike.half ? (p.fast_timer>0 ? 0.5 : (conf.DEFUSE_TIME/2)) : 0;

                let moving = false;
                if(!is_planting && !is_defusing && !is_healing) {
                    let ox = p.x, oy = p.y;
                    if(inp.w) { p.y -= conf.P_SPEED; moving=true; }
                    if(inp.s) { p.y += conf.P_SPEED; moving=true; }
                    if(inp.a) { p.x -= conf.P_SPEED; moving=true; }
                    if(inp.d) { p.x += conf.P_SPEED; moving=true; }
                    if(p.x<0) p.x=0; if(p.x>WIDTH-P_SIZE) p.x=WIDTH-P_SIZE;
                    if(p.y<UI_MARGIN) p.y=UI_MARGIN; if(p.y>HEIGHT-UI_MARGIN-P_SIZE) p.y=HEIGHT-UI_MARGIN-P_SIZE;
                    WALLS.forEach(w => { if(p.x < w.x+w.w && p.x+P_SIZE > w.x && p.y < w.y+w.h && p.y+P_SIZE > w.y) { p.x=ox; p.y=oy; } });
                }

                let fresh_shoot = inp.shoot && !p.shoot_last; p.shoot_last = inp.shoot;
                if(fresh_shoot && !inp.interact && !inp.tab && p.cd <= 0 && opp.alive && !(role === 'attacker' && p.invis_active)) {
                    if(p.weapon === 'FIST') { p.cd = conf.WEAPONS.FIST.cd; spawnBullet(room, role, p, opp, false); }
                    else if(p.mag > 0 && !p.reloading) {
                        if(conf.WEAPONS[p.weapon].type === 'burst' && p.mag >= 3) { p.mag -= 3; p.burst_shots = 3; p.cd = conf.WEAPONS[p.weapon].cd; }
                        else if(conf.WEAPONS[p.weapon].type !== 'burst') { p.mag--; p.cd = conf.WEAPONS[p.weapon].cd; spawnBullet(room, role, p, opp, moving); }
                    } else if(p.mag <= 0 && p.res > 0 && !p.reloading) { p.reloading = true; p.reload_timer = conf.RELOAD_TIME; }
                }
            });

            for(let i = state.bullets.length-1; i >= 0; i--) {
                let b = state.bullets[i], hitWall = false, hitPlayer = false;
                let steps = 4; let stepX = b.vx / steps, stepY = b.vy / steps;
                let oppRole = b.owner === 'attacker' ? 'defender' : 'attacker', opp = state.players[oppRole];

                for(let step = 0; step < steps; step++) {
                    b.x += stepX; b.y += stepY;
                    WALLS.forEach(w => { if(b.x-b.r < w.x+w.w && b.x+b.r > w.x && b.y-b.r < w.y+w.h && b.y+b.r > w.y) hitWall = true; });
                    if(hitWall || b.x<0 || b.x>WIDTH || b.y<UI_MARGIN || b.y>HEIGHT-UI_MARGIN) { hitWall = true; break; }
                    if(oppRole === 'defender' && opp.decoy_active && opp.decoy_pos && b.x>opp.decoy_pos.x && b.x<opp.decoy_pos.x+P_SIZE && b.y>opp.decoy_pos.y && b.y<opp.decoy_pos.y+P_SIZE) { hitWall = true; break; }

                    if(opp.alive && b.x>opp.x && b.x<opp.x+P_SIZE && b.y>opp.y && b.y<opp.y+P_SIZE) {
                        hitPlayer = true; let dmg = b.dmg;
                        if (opp.shield > 0) { let absorb = Math.min(opp.shield, dmg); opp.shield -= absorb; dmg -= absorb; if (opp.shield <= 0) opp.shield_type = 'NONE'; }
                        opp.hp -= dmg;
                        if(opp.hp <= 0) { opp.alive = false; state.creds[b.owner] += 200; state.players[b.owner].ult_pts = Math.min(conf.ULT_POINTS_NEEDED, state.players[b.owner].ult_pts + 1); }
                        break;
                    }
                }
                if(hitWall || hitPlayer) state.bullets.splice(i, 1);
            }

            let round_ended = false;
            if(state.spike.planted) { state.spike.timer -= dt; if(state.spike.timer <= 0) { processEndRound(room, 'attacker'); round_ended = true; } }
            else { state.round_timer -= dt; if(state.round_timer <= 0) { processEndRound(room, 'defender'); round_ended = true; } }

            if(!round_ended) {
                let att = state.players.attacker, def = state.players.defender;
                if(!att.alive && !def.alive) resetRound(room); 
                else if(!att.alive && !state.spike.planted) processEndRound(room, 'defender');
                else if(!def.alive) processEndRound(room, 'attacker');
            }
        }

        let packet = JSON.stringify({type: 'update', state: state});
        if (packet !== room.lastStateJson) {
            room.lastStateJson = packet;
            Object.values(room.clients).forEach(c => {
                if (c && !c.isBot && c.readyState === WebSocket.OPEN) c.send(packet);
            });
            room.spectators.forEach(s => {
                if (s.readyState === WebSocket.OPEN) s.send(packet);
            });
        }
    }
}, 1000 / tickRate);
