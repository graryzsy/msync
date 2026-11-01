/* Executed by macOS JavaScript for Automation, not Node. No credentials or private APIs. */
function run(argv) {
    var request = JSON.parse(argv[0]);
    var music = Application('Music');
    if (!music.running()) throw new Error('请先打开 Music.app 并完成资料库同步');
    var library = music.libraryPlaylists[0];
    var accountID = 'music-library:' + library.persistentID();
    function dateText(value) {
        if (!(value instanceof Date) || isNaN(value.getTime()) || value.getFullYear() < 1000) return null;
        function pad(n) { return n < 10 ? '0' + n : String(n); }
        return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
    }
    function row(p) {
        return {
            persistentID: p.persistentID, title: p.name || '', artist: p.artist || '',
            album: p.album || '', albumArtist: p.albumArtist || p.artist || '',
            date: dateText(p.releaseDate), durationMS: Math.round((p.duration || 0) * 1000),
            discNumber: p.discNumber || null, trackNumber: p.trackNumber || null,
            favorited: typeof p.favorited === 'boolean' ? p.favorited : null,
            albumFavorited: typeof p.albumFavorited === 'boolean' ? p.albumFavorited : null
        };
    }
    if (request.action === 'scan') {
        // A single bulk Apple event avoids one event for every property of every song.
        var properties = library.tracks.properties();
        return JSON.stringify({ accountID: accountID, rows: properties.map(row) });
    }
    if (request.action === 'write') {
        if (!/^[A-Fa-f0-9]{16}$/.test(request.persistentID) || typeof request.saved !== 'boolean') throw new Error('无效操作');
        if (request.accountID !== accountID) throw new Error('资料库已改变');
        var matches = library.tracks.whose({ persistentID: request.persistentID })();
        if (matches.length !== 1) throw new Error('找不到唯一条目');
        var track = matches[0], p = row(track.properties());
        if (p.title !== request.title && request.kind === 'track') throw new Error('曲目身份已改变');
        if (p.album !== request.album || p.albumArtist !== request.albumArtist || p.date !== request.date) throw new Error('发行版本已改变');
        if (request.kind === 'track') {
            if (p.favorited === null) throw new Error('当前 Music.app 不支持歌曲喜爱属性');
            track.favorited = request.saved;
        } else if (request.kind === 'album') {
            if (p.albumFavorited === null) throw new Error('当前 Music.app 不支持专辑喜爱属性');
            track.albumFavorited = request.saved;
        } else throw new Error('艺人收藏需在 Music.app 中处理');
        return JSON.stringify({ applied: true });
    }
    throw new Error('未知操作');
}
