/*
 * traffic-killer
 * CORS + browser-native cross-origin image fallback.
 * Replace the original main.js with this file.
 */

var maxtheard = 0;
var testurl = '';
var lsat_date = 0;

var CountryCode_Zh_cn = {
    US: '美国',
    CA: '加拿大',
    HK: '香港(中国)',
    TW: '台湾(中国)',
    SG: '新加坡',
    JP: '日本',
    KR: '韩国',
    AU: '澳大利亚',
    NZ: '新西兰',
    CN: '中国',
    GB: '英国',
    DE: '德国',
    FR: '法国',
    NL: '荷兰',
    IT: '意大利',
    ES: '西班牙',
    RU: '俄罗斯',
    IN: '印度',
    ID: '印度尼西亚',
    MY: '马来西亚',
    TH: '泰国',
    VN: '越南',
    PH: '菲律宾',
    BR: '巴西',
    AR: '阿根廷',
    MX: '墨西哥',
    TR: '土耳其',
    AE: '阿联酋',
    IL: '以色列',
    ZA: '南非',
    SE: '瑞典',
    CH: '瑞士',
    PL: '波兰'
};

var all_down_sum = 0;
var run = false;
var checkIP = true;
var visibl = true;
var thread_down = [];
var lsat_all_down = 0;
var refresh_lay = 5000;

var now_speed = 0;
var now_local_ping = 0;
var now_global_ping = 0;

/*
 * 下载模式：
 *
 * cors：
 *   使用 fetch + ReadableStream
 *   可以精确统计实际读取到的字节数
 *
 * browser：
 *   使用浏览器原生 Image 加载
 *   不需要目标服务器提供 CORS
 *   适合 cloud.139.com 等图片资源
 *
 * 注意：
 *   browser 模式下如果目标服务器没有 Timing-Allow-Origin，
 *   浏览器不会向 JS 暴露 transferSize，因此不能伪造真实速度。
 */
var download_mode = 'cors';

var run_generation = 0;

var thread_readers = [];
var thread_controllers = [];

var browser_resources = [];

var browser_measured_bytes = 0;
var browser_unmeasured = false;
var browser_completed = 0;
var browser_failures = 0;

var start_time = 0;


/*
 * 给 URL 增加缓存随机参数。
 *
 * 例如：
 *
 * https://example.com/a.png
 *
 * 变成：
 *
 * https://example.com/a.png?_tk=xxx
 *
 * 如果 URL 已经存在 ?：
 *
 * https://example.com/a.png?a=1&_tk=xxx
 *
 * 主要用于避免浏览器 / CDN 直接命中本地缓存。
 */
function cacheBustUrl(url, index) {
    var separator = url.indexOf('?') >= 0 ? '&' : '?';

    return url +
        separator +
        '_tk=' +
        Date.now().toString(36) +
        '_' +
        index +
        '_' +
        Math.random().toString(36).slice(2, 9);
}


/*
 * 更新页面描述文字。
 */
function setDescribe(text) {
    var el = document.getElementById('describe');

    if (el) {
        el.innerText = text;
    }
}


/*
 * 清理一个浏览器 Image 资源。
 */
function clearBrowserResource(resource) {
    if (!resource) {
        return;
    }

    try {
        resource.onload = null;
        resource.onerror = null;
        resource.removeAttribute('src');
    } catch (e) {}

    try {
        if (resource.parentNode) {
            resource.parentNode.removeChild(resource);
        }
    } catch (e) {}
}


/*
 * 停止所有下载线程 / Image。
 */
function cleanupWorkers() {

    /*
     * 清理 fetch reader
     */
    for (var i = 0; i < thread_readers.length; i++) {
        try {
            if (thread_readers[i]) {
                thread_readers[i].cancel();
            }
        } catch (e) {}
    }

    thread_readers = [];


    /*
     * 中止 fetch
     */
    for (var j = 0; j < thread_controllers.length; j++) {
        try {
            if (thread_controllers[j]) {
                thread_controllers[j].abort();
            }
        } catch (e) {}
    }

    thread_controllers = [];


    /*
     * 清理浏览器 Image
     */
    for (var k = 0; k < browser_resources.length; k++) {
        clearBrowserResource(browser_resources[k]);
    }

    browser_resources = [];
}


/*
 * 尝试读取 Performance Resource Timing 中的 transferSize。
 *
 * 注意：
 * 跨域资源如果没有 Timing-Allow-Origin：
 *
 * transferSize 通常会被浏览器隐藏。
 */
function getPerformanceTransferSize(url) {

    try {

        var entries = performance.getEntriesByName(url);

        if (!entries || entries.length === 0) {
            return 0;
        }

        var total = 0;

        for (var i = 0; i < entries.length; i++) {

            var n = Number(entries[i].transferSize || 0);

            if (n > 0) {
                total += n;
            }
        }

        return total;

    } catch (e) {

        return 0;
    }
}


/*
 * 判断一个 URL 是否很可能是图片。
 *
 * 主要用于提示用户。
 */
function isLikelyImageUrl(url) {

    try {

        var u = new URL(url, window.location.href);

        var path = (u.pathname || '').toLowerCase();

        return (
            /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)(?:$|\/)/i.test(path)
            ||
            /image|img|pic|picture|photo|avatar|cover/i.test(path)
        );

    } catch (e) {

        return /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)(?:$|[?#])/i.test(url);
    }
}


/*
 * 浏览器原生图片探测。
 *
 * 这个请求不要求 CORS：
 *
 * new Image()
 * img.src = xxx
 *
 * 对 cloud.139.com 这种图片地址特别有用。
 */
function testBrowserImage(url, timeout) {

    timeout = timeout || 10000;

    return new Promise(function(resolve) {

        var img = new Image();

        var finished = false;

        var timer = null;

        var probeUrl = cacheBustUrl(url, 'probe');


        function finish(ok) {

            if (finished) {
                return;
            }

            finished = true;

            if (timer) {
                clearTimeout(timer);
            }

            img.onload = null;
            img.onerror = null;

            try {
                img.removeAttribute('src');
            } catch (e) {}

            resolve(ok);
        }


        img.referrerPolicy = 'no-referrer';

        img.decoding = 'async';


        img.onload = function() {
            finish(true);
        };


        img.onerror = function() {
            finish(false);
        };


        timer = setTimeout(function() {
            finish(false);
        }, timeout);


        img.src = probeUrl;
    });
}


/*
 * 尝试 CORS 模式。
 *
 * 返回：
 *
 * true  = 可以正常 fetch
 * false = CORS 不可用
 */
async function tryCors() {

    var controller = new AbortController();

    var timer = setTimeout(function() {
        controller.abort();
    }, 8000);


    try {

        var response = await fetch(testurl, {
            cache: 'no-store',
            mode: 'cors',
            referrerPolicy: 'no-referrer',
            signal: controller.signal
        });


        if (
            !response ||
            !response.ok ||
            !response.body
        ) {
            throw new Error('CORS response unavailable');
        }


        var reader = response.body.getReader();

        var first = await reader.read();


        if (
            first.done ||
            !first.value ||
            first.value.length <= 0
        ) {

            try {
                await reader.cancel();
            } catch (e) {}

            throw new Error('empty response');
        }


        try {
            await reader.cancel();
        } catch (e) {}


        return true;

    } catch (err) {

        console.warn(
            '[traffic-killer] CORS check failed:',
            err
        );

        return false;

    } finally {

        clearTimeout(timer);

        try {
            controller.abort();
        } catch (e) {}
    }
}


/*
 * CORS 流式下载线程。
 *
 * 原始 traffic-killer 的核心下载方式。
 */
async function start_thread(index, generation) {

    try {

        if (
            !run ||
            generation !== run_generation ||
            download_mode !== 'cors'
        ) {
            return;
        }


        var controller = new AbortController();

        thread_controllers[index] = controller;


        var response = await fetch(testurl, {
            cache: 'no-store',
            mode: 'cors',
            referrerPolicy: 'no-referrer',
            signal: controller.signal
        });


        if (
            !response ||
            !response.body
        ) {
            throw new Error('response body unavailable');
        }


        var reader = response.body.getReader();

        thread_readers[index] = reader;


        while (true) {

            var result = await reader.read();

            var value = result.value;

            var done = result.done;


            /*
             * 下载结束
             */
            if (done) {

                try {
                    reader.releaseLock();
                } catch (e) {}

                thread_readers[index] = null;


                /*
                 * 自动重新开始
                 */
                if (
                    run &&
                    generation === run_generation
                ) {

                    start_thread(
                        index,
                        generation
                    );
                }

                break;
            }


            /*
             * 已经停止
             */
            if (
                !run ||
                generation !== run_generation
            ) {

                try {
                    await reader.cancel();
                } catch (e) {}

                break;
            }


            /*
             * 累加实际下载字节数
             */
            if (
                value &&
                value.length
            ) {

                thread_down[index] += value.length;
            }
        }


    } catch (err) {

        if (
            err &&
            err.name !== 'AbortError'
        ) {

            console.log(
                '[traffic-killer] thread ' +
                index +
                ':',
                err
            );
        }


        /*
         * 失败后自动重试
         */
        if (
            run &&
            generation === run_generation &&
            download_mode === 'cors'
        ) {

            setTimeout(function() {

                start_thread(
                    index,
                    generation
                );

            }, 250);
        }
    }
}


/*
 * 浏览器原生 Image 下载线程。
 *
 * 重要：
 *
 * 这种模式不使用 fetch。
 *
 * 因此即使目标服务器没有：
 *
 * Access-Control-Allow-Origin: *
 *
 * 浏览器仍然可以加载图片。
 */
function start_browser_thread(index, generation) {

    if (
        !run ||
        generation !== run_generation ||
        download_mode !== 'browser'
    ) {
        return;
    }


    var resource = new Image();

    var requestUrl = cacheBustUrl(
        testurl,
        index
    );

    var finished = false;

    var watchdog = null;


    function finish(success) {

        if (finished) {
            return;
        }

        finished = true;


        if (watchdog) {
            clearTimeout(watchdog);
        }


        /*
         * 尝试从 Resource Timing 获取实际传输大小。
         *
         * 没有 Timing-Allow-Origin 时通常为 0。
         */
        var measured = getPerformanceTransferSize(
            requestUrl
        );


        if (measured > 0) {

            thread_down[index] += measured;

            browser_measured_bytes += measured;

        } else {

            browser_unmeasured = true;
        }


        if (success) {
            browser_completed++;
        } else {
            browser_failures++;
        }


        browser_resources[index] = null;

        clearBrowserResource(resource);


        /*
         * 自动循环加载。
         */
        if (
            run &&
            generation === run_generation &&
            download_mode === 'browser'
        ) {

            setTimeout(function() {

                start_browser_thread(
                    index,
                    generation
                );

            }, success ? 0 : 350);
        }
    }


    resource.referrerPolicy = 'no-referrer';

    resource.decoding = 'async';

    resource.alt = '';

    resource.width = 1;

    resource.height = 1;


    /*
     * 隐藏 Image。
     */
    resource.style.position = 'fixed';

    resource.style.left = '-10000px';

    resource.style.top = '0';

    resource.style.width = '1px';

    resource.style.height = '1px';

    resource.style.opacity = '0';

    resource.style.pointerEvents = 'none';


    resource.onload = function() {
        finish(true);
    };


    resource.onerror = function() {
        finish(false);
    };


    /*
     * 防止某些资源一直不触发 onload / onerror。
     */
    watchdog = setTimeout(function() {
        finish(false);
    }, 30000);


    browser_resources[index] = resource;


    document.body.appendChild(resource);


    resource.src = requestUrl;
}


/*
 * 启动浏览器兼容模式。
 *
 * 目前针对的是图片资源。
 */
async function startBrowserMode() {

    return await testBrowserImage(
        testurl,
        10000
    );
}


/*
 * 开始下载。
 */
async function start() {

    /*
     * 如果已经达到 Maximum，
     * 下一次开始时重新计算。
     */
    if (
        all_down_sum >= Maximum &&
        Maximum != 0
    ) {

        all_down_sum = 0;
    }


    /*
     * 读取线程数。
     */
    maxtheard = parseInt(
        document.getElementById('thread').value,
        10
    ) || 1;


    if (maxtheard < 1) {
        maxtheard = 1;
    }


    /*
     * 防止输入过高导致手机浏览器直接崩溃。
     */
    if (maxtheard > 512) {
        maxtheard = 512;
    }


    /*
     * 读取 URL。
     */
    testurl = document
        .getElementById('link')
        .value
        .trim();


    if (testurl.length < 10) {

        alert('链接不合法');

        return;
    }


    /*
     * 自动修正 HTTPS / HTTP 大小写。
     */
    testurl =
        testurl.substring(0, 5).toLowerCase() +
        testurl.substring(5);


    if (!checkURL(testurl)) {

        alert('链接不合法');

        return;
    }


    /*
     * 不允许 HTTP。
     *
     * 因为页面一般本身运行在 HTTPS。
     */
    if (testurl.startsWith('http://')) {

        alert(
            '由于浏览器安全限制，不支持http协议，请使用https协议'
        );

        return;
    }


    if (!testurl.startsWith('https://')) {

        alert('链接不合法');

        return;
    }


    /*
     * 先清理旧线程。
     */
    cleanupWorkers();


    browser_completed = 0;

    browser_measured_bytes = 0;

    browser_unmeasured = false;

    browser_failures = 0;


    /*
     * 初始化线程统计。
     */
    thread_down = [];


    for (
        var i = 0;
        i < maxtheard;
        i++
    ) {

        thread_down[i] = 0;
    }


    var button =
        document.getElementById('do');


    if (button) {

        button.innerText =
            '正在检验链接...';

        button.disabled = true;
    }


    /*
     * 第一阶段：
     *
     * 优先尝试 CORS。
     */
    download_mode = 'cors';


    var corsOk = await tryCors();


    /*
     * CORS 失败：
     *
     * 自动尝试浏览器 Image。
     */
    if (!corsOk) {

        download_mode = 'browser';


        setDescribe(
            '正在使用浏览器兼容模式'
        );


        var browserOk =
            await startBrowserMode();


        /*
         * 如果连 Image 都无法加载，
         * 才真正判定 URL 不可用。
         */
        if (!browserOk) {

            download_mode = 'cors';


            if (button) {

                button.innerText = '开始';

                button.disabled = false;
            }


            alert(
                '该链接无法通过跨域读取，也无法作为浏览器图片资源加载。\n\n' +
                '如果手机浏览器可以直接打开该链接，请确认它是 PNG、JPG、WEBP、GIF、SVG 等可直接嵌入的图片资源。'
            );

            return;
        }
    }


    /*
     * 到这里说明测试地址有效。
     */
    setDescribe(
        download_mode === 'cors'
            ? '实时速度'
            : '浏览器兼容模式'
    );


    if (button) {

        button.innerText = '停止';

        button.disabled = false;
    }


    lsat_all_down = 0;

    start_time =
        new Date().getTime();

    lsat_date =
        new Date().getTime();


    run = true;

    run_generation++;

    var generation =
        run_generation;


    /*
     * 根据模式启动线程。
     */
    if (download_mode === 'cors') {

        for (
            var n = 0;
            n < maxtheard;
            n++
        ) {

            start_thread(
                n,
                generation
            );
        }

    } else {

        for (
            var b = 0;
            b < maxtheard;
            b++
        ) {

            start_browser_thread(
                b,
                generation
            );
        }
    }


    /*
     * 启动速度计算。
     */
    cale();


    /*
     * 启动总流量计算。
     */
    total();
}


/*
 * 停止。
 */
function stop() {

    run = false;

    run_generation++;


    cleanupWorkers();


    var button =
        document.getElementById('do');


    if (button) {

        button.innerText = '开始';

        button.disabled = false;
    }


    if (
        download_mode === 'browser' &&
        browser_unmeasured
    ) {

        setDescribe(
            '已停止（浏览器兼容模式）'
        );
    }
}


/*
 * 数组求和。
 */
function sum(arr) {

    var s = 0;


    for (
        var i = 0;
        i < arr.length;
        i++
    ) {

        s += Number(
            arr[i] || 0
        );
    }


    return s;
}


/*
 * 开始 / 停止按钮。
 *
 * 注意原项目拼写：
 * botton_clicked
 *
 * 保持不改，避免 index.html 中事件失效。
 */
function botton_clicked() {

    if (run) {

        stop();

    } else {

        start();
    }
}


/*
 * URL 检查。
 */
function checkURL(URL) {

    try {

        var u = new URL(URL);


        return (
            u.protocol === 'https:' &&
            !!u.hostname
        );

    } catch (e) {

        return false;
    }
}


/*
 * 速度计算。
 */
async function cale() {

    var now =
        new Date().getTime();


    var elapsed =
        now - lsat_date;


    if (elapsed <= 0) {

        elapsed = 1;
    }


    var all_down_a =
        sum(thread_down);


    var delta =
        all_down_a - lsat_all_down;


    /*
     * 浏览器兼容模式：
     *
     * 如果浏览器没有提供 transferSize，
     * 则不能显示伪造速度。
     */
    if (
        download_mode === 'browser' &&
        browser_measured_bytes === 0
    ) {

        now_speed = 0;


        if (visibl) {

            document.getElementById(
                'speed'
            ).innerText =
                '浏览器下载';


            document.getElementById(
                'mbps'
            ).innerText =
                '无法读取';
        }


    } else {

        /*
         * MB/s
         */
        now_speed =
            delta /
            elapsed *
            1000 /
            1024 /
            1024;


        if (visibl) {

            document.getElementById(
                'speed'
            ).innerText =
                show(
                    delta /
                    elapsed *
                    1000,
                    [
                        'B/s',
                        'KB/s',
                        'MB/s',
                        'GB/s',
                        'TB/s',
                        'PB/s'
                    ],
                    [
                        0,
                        0,
                        1,
                        2,
                        2,
                        2
                    ]
                );


            document.getElementById(
                'mbps'
            ).innerText =
                show(
                    delta /
                    elapsed *
                    8000,
                    [
                        'Bps',
                        'Kbps',
                        'Mbps',
                        'Gbps',
                        'Tbps',
                        'Pbps'
                    ],
                    [
                        0,
                        0,
                        0,
                        2,
                        2,
                        2
                    ]
                );
        }


        if (!visibl) {

            document.title =
                show(
                    all_down_sum +
                    all_down_a,
                    [
                        'B',
                        'KB',
                        'MB',
                        'GB',
                        'TB',
                        'PB'
                    ],
                    [
                        0,
                        0,
                        0,
                        2,
                        2,
                        2
                    ]
                ) +
                ' ' +
                show(
                    delta /
                    elapsed *
                    1000,
                    [
                        'B/s',
                        'KB/s',
                        'MB/s',
                        'GB/s',
                        'TB/s',
                        'PB/s'
                    ],
                    [
                        0,
                        0,
                        0,
                        2,
                        2,
                        2
                    ]
                );
        }
    }


    lsat_all_down =
        all_down_a;

    lsat_date =
        now;


    /*
     * 继续计算。
     */
    if (run) {

        setTimeout(
            cale,
            1000
        );

    } else {

        var duration =
            now - start_time;


        if (duration <= 0) {

            duration = 1;
        }


        var avg_speed =
            1000 *
            all_down_a /
            duration;


        document.title =
            '流量杀手';


        now_speed = 0;


        if (visibl) {

            if (
                download_mode === 'browser' &&
                browser_measured_bytes === 0
            ) {

                document.getElementById(
                    'speed'
                ).innerText =
                    '浏览器下载';


                document.getElementById(
                    'mbps'
                ).innerText =
                    '无法读取';

            } else {

                document.getElementById(
                    'speed'
                ).innerText =
                    show(
                        avg_speed,
                        [
                            'B/s',
                            'KB/s',
                            'MB/s',
                            'GB/s',
                            'TB/s',
                            'PB/s'
                        ],
                        [
                            0,
                            0,
                            1,
                            2,
                            2,
                            2
                        ]
                    );


                document.getElementById(
                    'mbps'
                ).innerText =
                    show(
                        avg_speed * 8,
                        [
                            'Bps',
                            'Kbps',
                            'Mbps',
                            'Gbps',
                            'Tbps',
                            'Pbps'
                        ],
                        [
                            0,
                            0,
                            0,
                            2,
                            2,
                            2
                        ]
                    );
            }


            document.getElementById(
                'describe'
            ).innerText =
                download_mode === 'browser'
                    ? '已停止（浏览器兼容模式）'
                    : '平均速度';
        }


        lsat_all_down = 0;
    }
}


/*
 * 总流量。
 */
async function total() {

    var all_down =
        sum(thread_down);


    if (visibl) {

        document.getElementById(
            'total'
        ).innerText =
            show(
                all_down_sum +
                all_down,
                [
                    'B',
                    'KB',
                    'MB',
                    'GB',
                    'TB',
                    'PB'
                ],
                [
                    0,
                    0,
                    1,
                    2,
                    2,
                    2
                ]
            );
    }


    /*
     * Browser 模式只有在浏览器能够暴露真实
     * transferSize 时才能执行 Maximum 限制。
     *
     * 否则如果强行用 thread_down 作为判断，
     * 就会把真实下载的未知流量误认为 0。
     */
    if (
        download_mode !== 'browser' ||
        browser_measured_bytes > 0
    ) {

        if (
            (
                all_down_sum +
                all_down
            ) >= Maximum &&
            Maximum != 0
        ) {

            stop();
        }
    }


    if (run) {

        setTimeout(
            total,
            16
        );

    } else {

        all_down_sum +=
            all_down;


        if (visibl) {

            document.getElementById(
                'total'
            ).innerText =
                show(
                    all_down_sum,
                    [
                        'B',
                        'KB',
                        'MB',
                        'GB',
                        'TB',
                        'PB'
                    ],
                    [
                        0,
                        0,
                        1,
                        2,
                        2,
                        2
                    ]
                );
        }
    }
}


/*
 * 中国 IP 信息。
 */
var cnip = '';


function ipcn() {

    if (visibl) {

        fetch(
            'https://forge.speedtest.cn/api/location/info',
            {
                referrerPolicy: 'no-referrer'
            }
        )
        .then(function(response) {

            return response.json();

        })
        .then(function(data) {

            var tag =
                document.getElementById(
                    'ipcn'
                );


            if (!tag) {
                return;
            }


            tag.innerText =
                data.ip +
                ' ' +
                data.province +
                ' ' +
                data.city +
                ' ' +
                data.distinct +
                ' ' +
                data.isp;


            if (data.ip !== cnip) {

                tag.style.color = '';

                ckip(
                    data.ip,
                    tag
                );
            }


            cnip =
                data.ip;

        })
        .catch(function() {});
    }


    setTimeout(
        ipcn,
        5000
    );
}


/*
 * 全球 IP 信息。
 */
var gbip = '';


function ipgb() {

    if (visibl) {

        fetch(
            'https://api-ipv4.ip.sb/geoip',
            {
                referrerPolicy: 'no-referrer'
            }
        )
        .then(function(response) {

            return response.json();

        })
        .then(function(data) {

            var tag =
                document.getElementById(
                    'ipgb'
                );


            if (!tag) {
                return;
            }


            var country =
                CountryCode_Zh_cn[
                    data.country_code
                ] ||
                data.country_code ||
                '';


            tag.innerText =
                data.ip +
                ' ' +
                country +
                ' ' +
                data.isp;


            if (data.ip !== gbip) {

                tag.style.color = '';

                ckip(
                    data.ip,
                    tag
                );
            }


            gbip =
                data.ip;

        })
        .catch(function() {});
    }


    setTimeout(
        ipgb,
        refresh_lay
    );
}


/*
 * 国内延迟。
 */
function laycn() {

    if (visibl) {

        var start_ti =
            new Date().getTime();


        fetch(
            'https://connectivitycheck.platform.hicloud.com/generate_204',
            {
                method: 'HEAD',
                cache: 'no-store',
                mode: 'no-cors',
                referrerPolicy: 'no-referrer'
            }
        )
        .then(function() {

            var lay =
                new Date().getTime() -
                start_ti;


            now_local_ping =
                lay;


            var el =
                document.getElementById(
                    'laycn'
                );


            if (el) {

                el.innerText =
                    lay +
                    'ms';
            }

        })
        .catch(function() {

            var el =
                document.getElementById(
                    'laycn'
                );


            if (el) {

                el.innerText =
                    '-ms';
            }
        });
    }


    setTimeout(
        laycn,
        1000
    );
}


/*
 * 全球延迟。
 */
function laygb() {

    if (visibl) {

        var start_ti =
            new Date().getTime();


        fetch(
            'https://cp.cloudflare.com/',
            {
                method: 'HEAD',
                cache: 'no-store',
                mode: 'no-cors',
                referrerPolicy: 'no-referrer'
            }
        )
        .then(function() {

            var lay =
                new Date().getTime() -
                start_ti;


            now_global_ping =
                lay;


            var el =
                document.getElementById(
                    'laygb'
                );


            if (el) {

                el.innerText =
                    lay +
                    'ms';
            }

        })
        .catch(function() {

            var el =
                document.getElementById(
                    'laygb'
                );


            if (el) {

                el.innerText =
                    '-ms';
            }
        });
    }


    setTimeout(
        laygb,
        1000
    );
}


/*
 * 判断某些站点是否可访问。
 */
function ckbl() {

    if (visibl) {

        var controller =
            new AbortController();


        setTimeout(function() {

            controller.abort();

        }, 2000);


        fetch(
            'https://twitter.com/',
            {
                signal:
                    controller.signal,

                method: 'HEAD',

                cache: 'no-store',

                mode: 'no-cors',

                referrerPolicy:
                    'no-referrer'
            }
        )
        .then(function() {

            var el =
                document.getElementById(
                    'laygb'
                );


            if (el) {

                el.style.color =
                    'green';
            }

        })
        .catch(function() {

            var el =
                document.getElementById(
                    'laygb'
                );


            if (el) {

                el.style.color =
                    'red';
            }
        });
    }


    setTimeout(
        ckbl,
        1000
    );
}


/*
 * 检查 IP 类型。
 */
function ckip(ip, tag) {

    if (checkIP) {

        fetch(
            'https://down.ljxnet.cn/?headers=%7B%22referer%22%3A%22https%3A%2F%2Fipinfo.io%2F%22%2C%22origin%22%3A%22https%3A%2F%2Fipinfo.io%2F%22%7D&url=https%3A%2F%2Fipinfo.io%2Fwidget%2Fdemo%2F' +
            ip
        )
        .then(function(response) {

            return response.json();

        })
        .then(function(data) {

            if (
                data &&
                data.data &&
                data.data.company
            ) {

                console.log(
                    data.input,
                    data.data.country,
                    data.data.city,
                    data.data.asn &&
                    data.data.asn.name,
                    data.data.company.type
                );


                if (
                    data.data.company.type ===
                    'isp'
                ) {

                    tag.style.color =
                        'green';
                }
            }

        })
        .catch(function() {});
    }
}


/*
 * 页面初始化。
 */
ipcn();

ipgb();

laycn();

laygb();

ckbl();


/*
 * 页面切换前后台。
 *
 * 保留原项目逻辑。
 */
document.addEventListener(
    'visibilitychange',
    function() {

        var state =
            document.visibilityState;


        if (state === 'hidden') {

            visibl = false;


            var switchEl =
                document.getElementById(
                    'customSwitch2'
                );


            if (
                run &&
                switchEl &&
                !switchEl.checked
            ) {

                botton_clicked();
            }
        }


        if (state === 'visible') {

            visibl = true;

            document.title =
                '流量杀手';


            if (
                download_mode === 'browser' &&
                browser_measured_bytes === 0
            ) {

                document.getElementById(
                    'speed'
                ).innerText =
                    '浏览器下载';


                document.getElementById(
                    'mbps'
                ).innerText =
                    '无法读取';
            }
        }
    }
);


/*
 * ECharts。
 */
var chartDom =
    document.getElementById('dv');


var myChart =
    echarts.init(chartDom);


var option;


/*
 * 图表配置。
 */
option = {

    tooltip: {

        trigger: 'axis',

        axisPointer: {

            type: 'cross',

            label: {
                backgroundColor:
                    '#6a7985'
            }
        }
    },


    legend: {

        data: [
            'Speed',
            'Local Ping',
            'Global Ping'
        ]
    },


    toolbox: {

        feature: {

            saveAsImage: {}
        }
    },


    grid: {

        left: '3%',

        right: '4%',

        bottom: '3%',

        containLabel: true
    },


    xAxis: [{

        type: 'category',

        name: '时间(s)',

        boundaryGap: false
    }],


    yAxis: [{

        type: 'value',

        name: '延迟(ms)',

        splitLine: {
            show: false
        }

    }, {

        type: 'value',

        name: '速率(MB/s)',

        splitLine: {
            show: false
        }
    }],


    series: [{

        name: '速率',

        type: 'line',

        stack: 'Total',

        yAxisIndex: 1,

        areaStyle: {},

        emphasis: {
            focus: 'series'
        },

        data: [{

            name: new Date(),

            value: now_global_ping
        }]

    }, {

        name: '延迟',

        type: 'line',

        data: [{

            name: new Date(),

            value: now_global_ping
        }]
    }]
};


option &&
myChart.setOption(option);


/*
 * 图表刷新。
 */
function dv() {

    if (visibl) {

        var now =
            new Date();


        option.series[0].data.push({

            name:
                now.toString(),

            value: [
                now.getTime(),
                now_speed.toFixed(1)
            ]
        });


        option.series[1].data.push({

            name:
                now.toString(),

            value: [
                now.getTime(),
                now_local_ping
            ]
        });


        myChart.setOption({

            series:
                option.series
        });
    }


    setTimeout(
        dv,
        1000
    );
}


dv();


console.log(
    '[traffic-killer] CORS fallback enabled'
);
