/*
 * traffic-killer
 *
 * 版本：
 * CORS + 流式代理兼容版
 *
 * 功能：
 * 1. CORS 地址继续直接 fetch + ReadableStream
 * 2. CORS 失败自动切换到自建流式代理
 * 3. 代理模式仍然使用 response.body.getReader()
 * 4. 实时 MB/s、Mbps、累计流量继续按照实际读取字节计算
 * 5. 支持 100 / 200 / 500 逻辑线程
 * 6. 停止时主动 Abort 所有连接
 *
 * 注意：
 * TRAFFIC_PROXY 必须指向你自己部署的代理。
 *
 * 示例：
 *
 * var TRAFFIC_PROXY =
 *     "https://traffic-proxy.example.com/?url=";
 *
 * 代理最终请求：
 *
 * https://traffic-proxy.example.com/?url=https%3A%2F%2Fcloud.139.com%2F....
 *
 */

var maxtheard;
var testurl;
var lsat_date = 0;

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

var start_time = 0;


/*
 * ============================================================
 * 流式代理地址
 * ============================================================
 *
 * 如果你没有配置代理：
 *
 * var TRAFFIC_PROXY = "";
 *
 * 那么 CORS 失败后会提示配置代理。
 *
 * Cloudflare Worker 示例：
 *
 * var TRAFFIC_PROXY =
 *     "https://traffic-proxy.xxxxx.workers.dev/?url=";
 *
 */
var TRAFFIC_PROXY =
    "https://YOUR-WORKER.workers.dev/?url=";


/*
 * 是否允许 CORS 失败后使用代理。
 */
var ENABLE_PROXY_FALLBACK = true;


/*
 * 当前运行模式：
 *
 * direct = 直接访问目标
 * proxy  = 通过流式代理访问
 */
var DOWNLOAD_MODE = "direct";


/*
 * 用于停止旧任务。
 *
 * 每次 start：
 *
 * generation++
 *
 * 旧线程检测到 generation 不一致后自动退出。
 */
var run_generation = 0;


/*
 * 每个线程对应一个 AbortController。
 */
var thread_controllers = [];


/*
 * ------------------------------------------------------------
 * 国家代码
 * ------------------------------------------------------------
 *
 * 原项目国家显示依赖 CountryCode_Zh_cn。
 *
 * 使用 Intl.DisplayNames 后不需要继续维护几百个国家代码。
 */
var CountryCode_Zh_cn = {
    "US": "美国",
    "CA": "加拿大",
    "HK": "香港(中国)",
    "TW": "台湾(中国)",
    "SG": "新加坡",
    "JP": "日本",
    "KR": "韩国",
    "AU": "澳大利亚",
    "NZ": "新西兰",
    "CN": "中国",
    "GB": "英国",
    "DE": "德国",
    "FR": "法国",
    "NL": "荷兰",
    "IT": "意大利",
    "ES": "西班牙",
    "RU": "俄罗斯",
    "IN": "印度",
    "ID": "印度尼西亚",
    "MY": "马来西亚",
    "TH": "泰国",
    "VN": "越南",
    "PH": "菲律宾",
    "BR": "巴西",
    "AR": "阿根廷",
    "MX": "墨西哥",
    "TR": "土耳其",
    "AE": "阿联酋",
    "IL": "以色列",
    "ZA": "南非",
    "SE": "瑞典",
    "CH": "瑞士",
    "PL": "波兰",
    "NO": "挪威",
    "FI": "芬兰",
    "DK": "丹麦",
    "BE": "比利时",
    "AT": "奥地利",
    "IE": "爱尔兰",
    "PT": "葡萄牙",
    "GR": "希腊",
    "CZ": "捷克",
    "RO": "罗马尼亚",
    "HU": "匈牙利",
    "UA": "乌克兰",
    "IL": "以色列",
    "SA": "沙特阿拉伯",
    "QA": "卡塔尔",
    "EG": "埃及",
    "PK": "巴基斯坦",
    "BD": "孟加拉国"
};


/*
 * ============================================================
 * URL
 * ============================================================
 */

function checkURL(URL) {

    try {

        var obj =
            new URL(URL);

        return (
            obj.protocol === "https:" &&
            !!obj.hostname
        );

    } catch (e) {

        return false;
    }
}


/*
 * 构造代理 URL。
 *
 * TRAFFIC_PROXY 必须以：
 *
 * ?url=
 *
 * 结尾。
 */
function buildProxyURL(url) {

    if (
        !TRAFFIC_PROXY ||
        !TRAFFIC_PROXY.trim()
    ) {
        return "";
    }


    return (
        TRAFFIC_PROXY +
        encodeURIComponent(url)
    );
}


/*
 * 当前真正用于 fetch 的地址。
 */
function getRequestURL() {

    if (
        DOWNLOAD_MODE === "proxy"
    ) {

        return buildProxyURL(
            testurl
        );
    }


    return testurl;
}


/*
 * ============================================================
 * Worker 清理
 * ============================================================
 */

function abortAllThreads() {

    for (
        var i = 0;
        i < thread_controllers.length;
        i++
    ) {

        try {

            if (
                thread_controllers[i]
            ) {

                thread_controllers[i].abort();
            }

        } catch (e) {}
    }


    thread_controllers = [];
}


/*
 * ============================================================
 * 流式下载线程
 * ============================================================
 *
 * 这里保留原 traffic-killer 的核心逻辑：
 *
 * fetch()
 *   ↓
 * response.body
 *   ↓
 * getReader()
 *   ↓
 * reader.read()
 *   ↓
 * value.byteLength
 *
 * 所以代理模式下仍然可以精确统计读取到的响应体字节数。
 *
 */

async function start_thread(
    index,
    generation
) {

    while (
        run &&
        generation === run_generation
    ) {

        var controller =
            new AbortController();


        thread_controllers[index] =
            controller;


        try {

            var requestURL =
                getRequestURL();


            if (!requestURL) {

                throw new Error(
                    "代理地址未配置"
                );
            }


            var response =
                await fetch(
                    requestURL,
                    {
                        cache:
                            "no-store",

                        mode:
                            "cors",

                        redirect:
                            "follow",

                        referrerPolicy:
                            "no-referrer",

                        signal:
                            controller.signal
                    }
                );


            if (
                !response ||
                !response.ok
            ) {

                throw new Error(
                    "HTTP " +
                    (
                        response
                            ? response.status
                            : "unknown"
                    )
                );
            }


            if (
                !response.body
            ) {

                throw new Error(
                    "响应没有 Body"
                );
            }


            var reader =
                response.body.getReader();


            while (true) {

                var result =
                    await reader.read();


                var value =
                    result.value;


                var done =
                    result.done;


                /*
                 * 下载完成。
                 *
                 * 继续开始下一轮下载。
                 */
                if (done) {

                    try {

                        reader.releaseLock();

                    } catch (e) {}


                    break;
                }


                /*
                 * 已停止。
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
                 * 统计实际读取到的响应体字节。
                 *
                 * Uint8Array：
                 *
                 * value.byteLength
                 */
                if (
                    value &&
                    value.byteLength
                ) {

                    thread_down[index] +=
                        value.byteLength;
                }
            }


        } catch (err) {

            /*
             * Abort 属于正常停止。
             */
            if (
                !err ||
                err.name !== "AbortError"
            ) {

                console.log(
                    "[traffic-killer]",
                    "thread:",
                    index,
                    "mode:",
                    DOWNLOAD_MODE,
                    err
                );
            }


            /*
             * 如果已经停止，
             * 不再重试。
             */
            if (
                !run ||
                generation !== run_generation
            ) {

                break;
            }


            /*
             * 当前模式失败。
             *
             * 不在这里偷偷切换模式，
             * 避免 500 个线程同时切换。
             *
             * start() 决定整个运行周期使用 direct
             * 还是 proxy。
             */
            await sleep(200);
        }


        /*
         * 下一轮。
         */
        if (
            run &&
            generation === run_generation
        ) {

            await sleep(0);
        }
    }


    thread_controllers[index] = null;
}


/*
 * 简单 sleep。
 */
function sleep(ms) {

    return new Promise(
        function(resolve) {

            setTimeout(
                resolve,
                ms
            );
        }
    );
}


/*
 * ============================================================
 * CORS 检测
 * ============================================================
 *
 * 只读取第一块数据。
 */
async function checkDirectStream() {

    var controller =
        new AbortController();


    var timer =
        setTimeout(
            function() {

                try {

                    controller.abort();

                } catch (e) {}

            },
            10000
        );


    try {

        var response =
            await fetch(
                testurl,
                {
                    cache:
                        "no-store",

                    mode:
                        "cors",

                    redirect:
                        "follow",

                    referrerPolicy:
                        "no-referrer",

                    signal:
                        controller.signal
                }
            );


        if (
            !response ||
            !response.ok
        ) {

            throw new Error(
                "HTTP " +
                (
                    response
                        ? response.status
                        : "unknown"
                )
            );
        }


        if (
            !response.body
        ) {

            throw new Error(
                "响应 Body 不可读取"
            );
        }


        var reader =
            response.body.getReader();


        var result =
            await reader.read();


        if (
            !result ||
            !result.value ||
            result.value.byteLength <= 0
        ) {

            throw new Error(
                "资源响应异常"
            );
        }


        try {

            await reader.cancel();

        } catch (e) {}


        return true;


    } catch (err) {

        console.warn(
            "[traffic-killer] direct CORS failed:",
            err
        );

        return false;

    } finally {

        clearTimeout(
            timer
        );

        try {

            controller.abort();

        } catch (e) {}
    }
}


/*
 * ============================================================
 * Proxy 检测
 * ============================================================
 *
 * 代理必须返回：
 *
 * Access-Control-Allow-Origin: *
 *
 * 并且 response.body 可读取。
 */
async function checkProxyStream() {

    var proxyURL =
        buildProxyURL(
            testurl
        );


    if (!proxyURL) {

        console.warn(
            "[traffic-killer] proxy not configured"
        );

        return false;
    }


    var controller =
        new AbortController();


    var timer =
        setTimeout(
            function() {

                try {

                    controller.abort();

                } catch (e) {}
            },
            15000
        );


    try {

        var response =
            await fetch(
                proxyURL,
                {
                    cache:
                        "no-store",

                    mode:
                        "cors",

                    redirect:
                        "follow",

                    referrerPolicy:
                        "no-referrer",

                    signal:
                        controller.signal
                }
            );


        if (
            !response ||
            !response.ok
        ) {

            throw new Error(
                "Proxy HTTP " +
                (
                    response
                        ? response.status
                        : "unknown"
                )
            );
        }


        if (
            !response.body
        ) {

            throw new Error(
                "Proxy Body 不可读取"
            );
        }


        var reader =
            response.body.getReader();


        var result =
            await reader.read();


        if (
            !result ||
            !result.value ||
            result.value.byteLength <= 0
        ) {

            throw new Error(
                "Proxy 返回空数据"
            );
        }


        try {

            await reader.cancel();

        } catch (e) {}


        return true;


    } catch (err) {

        console.error(
            "[traffic-killer] proxy test failed:",
            err
        );

        return false;

    } finally {

        clearTimeout(
            timer
        );

        try {

            controller.abort();

        } catch (e) {}
    }
}


/*
 * ============================================================
 * 开始
 * ============================================================
 */

async function start() {

    /*
     * 如果已经达到最大值，
     * 从头重新累计。
     */
    if (
        typeof Maximum !== "undefined" &&
        all_down_sum >= Maximum &&
        Maximum != 0
    ) {

        all_down_sum = 0;
    }


    /*
     * 获取线程数。
     */
    maxtheard =
        parseInt(
            document
                .getElementById("thread")
                .value,
            10
        );


    if (
        isNaN(maxtheard) ||
        maxtheard < 1
    ) {

        maxtheard = 1;
    }


    /*
     * 500 是允许的最大逻辑线程。
     */
    if (
        maxtheard > 500
    ) {

        maxtheard = 500;

        document
            .getElementById("thread")
            .value = 500;
    }


    /*
     * 获取测试 URL。
     */
    testurl =
        document
            .getElementById("link")
            .value
            .trim();


    if (
        testurl.length < 10
    ) {

        alert(
            "链接不合法"
        );

        return;
    }


    /*
     * 统一协议大小写。
     */
    testurl =
        testurl.substring(
            0,
            5
        ).toLowerCase() +
        testurl.substring(
            5
        );


    if (
        !checkURL(testurl)
    ) {

        alert(
            "链接不合法"
        );

        return;
    }


    if (
        testurl.startsWith(
            "http://"
        )
    ) {

        alert(
            "由于浏览器安全限制，不支持http协议，请使用https协议"
        );

        return;
    }


    if (
        !testurl.startsWith(
            "https://"
        )
    ) {

        alert(
            "链接不合法"
        );

        return;
    }


    var button =
        document.getElementById(
            "do"
        );


    var describe =
        document.getElementById(
            "describe"
        );


    button.innerText =
        "正在检验链接...";


    button.disabled =
        true;


    /*
     * --------------------------------------------------------
     * 第一优先：直接 CORS
     * --------------------------------------------------------
     */
    DOWNLOAD_MODE =
        "direct";


    var directOK =
        await checkDirectStream();


    /*
     * --------------------------------------------------------
     * CORS 不可用
     *
     * 自动尝试代理。
     * --------------------------------------------------------
     */
    if (!directOK) {

        if (
            !ENABLE_PROXY_FALLBACK
        ) {

            button.innerText =
                "开始";

            button.disabled =
                false;

            alert(
                "该链接不支持浏览器跨域读取。"
            );

            return;
        }


        /*
         * 检查代理。
         */
        DOWNLOAD_MODE =
            "proxy";


        describe.innerText =
            "正在切换代理流模式";


        var proxyOK =
            await checkProxyStream();


        if (!proxyOK) {

            DOWNLOAD_MODE =
                "direct";


            button.innerText =
                "开始";

            button.disabled =
                false;


            alert(
                "该链接无法直接读取，代理也不可用。\n\n" +
                "请检查 main.js 顶部 TRAFFIC_PROXY 配置。"
            );

            return;
        }
    }


    /*
     * 到这里已经确定整个运行周期使用的模式。
     */
    if (
        DOWNLOAD_MODE === "proxy"
    ) {

        describe.innerText =
            "实时速度（代理流）";

    } else {

        describe.innerText =
            "实时速度";
    }


    button.innerText =
        "停止";


    button.disabled =
        false;


    /*
     * 停止旧任务。
     */
    abortAllThreads();


    run_generation++;


    var generation =
        run_generation;


    lsat_all_down =
        0;


    lsat_date =
        new Date().getTime();


    start_time =
        new Date().getTime();


    run =
        true;


    thread_down =
        [];


    thread_controllers =
        [];


    /*
     * 初始化线程。
     *
     * 使用异步启动，
     * 防止 500 个线程在同一 JS tick 内瞬间创建。
     */
    for (
        var i = 0;
        i < maxtheard;
        i++
    ) {

        thread_down[i] = 0;

        thread_controllers[i] =
            null;


        /*
         * 每个线程稍微错开。
         *
         * 对 500 线程手机浏览器更加友好。
         */
        (
            function(index) {

                setTimeout(
                    function() {

                        if (
                            run &&
                            generation === run_generation
                        ) {

                            start_thread(
                                index,
                                generation
                            );
                        }

                    },
                    Math.min(
                        index * 2,
                        1000
                    )
                );

            }
        )(i);
    }


    /*
     * 启动速度计算。
     */
    cale();


    /*
     * 启动总流量统计。
     */
    total();
}


/*
 * ============================================================
 * 停止
 * ============================================================
 */

function stop() {

    run =
        false;


    run_generation++;


    abortAllThreads();


    var button =
        document.getElementById(
            "do"
        );


    if (button) {

        button.innerText =
            "开始";

        button.disabled =
            false;
    }


    document.title =
        "流量杀手";
}


/*
 * ============================================================
 * 求和
 * ============================================================
 */

function sum(arr) {

    var s = 0;


    for (
        var i = 0;
        i < arr.length;
        i++
    ) {

        s +=
            Number(
                arr[i] || 0
            );
    }


    return s;
}


/*
 * ============================================================
 * 开始/停止按钮
 * ============================================================
 */

function botton_clicked() {

    if (run) {

        stop();

    } else {

        start();
    }
}


/*
 * ============================================================
 * 实时速度
 * ============================================================
 */

async function cale() {

    var now =
        new Date().getTime();


    var elapsed =
        now -
        lsat_date;


    if (
        elapsed <= 0
    ) {

        elapsed = 1;
    }


    var all_down_a =
        sum(thread_down);


    var delta =
        all_down_a -
        lsat_all_down;


    /*
     * 每秒 Bytes。
     */
    var bytesPerSecond =
        delta /
        elapsed *
        1000;


    /*
     * MB/s。
     */
    now_speed =
        bytesPerSecond /
        1024 /
        1024;


    if (visibl) {

        var speed =
            document.getElementById(
                "speed"
            );


        var mbps =
            document.getElementById(
                "mbps"
            );


        if (speed) {

            speed.innerText =
                show(
                    bytesPerSecond,
                    [
                        "B/s",
                        "KB/s",
                        "MB/s",
                        "GB/s",
                        "TB/s",
                        "PB/s"
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


        if (mbps) {

            mbps.innerText =
                show(
                    bytesPerSecond * 8,
                    [
                        "Bps",
                        "Kbps",
                        "Mbps",
                        "Gbps",
                        "Tbps",
                        "Pbps"
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


    /*
     * 页面在后台：
     * 用标题显示速度。
     */
    if (!visibl) {

        document.title =
            show(
                all_down_sum +
                all_down_a,
                [
                    "B",
                    "KB",
                    "MB",
                    "GB",
                    "TB",
                    "PB"
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
            " " +
            show(
                bytesPerSecond,
                [
                    "B/s",
                    "KB/s",
                    "MB/s",
                    "GB/s",
                    "TB/s",
                    "PB/s"
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


    lsat_all_down =
        all_down_a;


    lsat_date =
        now;


    if (run) {

        setTimeout(
            cale,
            1000
        );

        return;
    }


    /*
     * 停止后计算平均速度。
     */
    var totalElapsed =
        now -
        start_time;


    if (
        totalElapsed <= 0
    ) {

        totalElapsed = 1;
    }


    var avg_speed =
        1000 *
        all_down_a /
        totalElapsed;


    now_speed = 0;


    document.title =
        "流量杀手";


    if (visibl) {

        var speedEnd =
            document.getElementById(
                "speed"
            );


        var mbpsEnd =
            document.getElementById(
                "mbps"
            );


        if (speedEnd) {

            speedEnd.innerText =
                show(
                    avg_speed,
                    [
                        "B/s",
                        "KB/s",
                        "MB/s",
                        "GB/s",
                        "TB/s",
                        "PB/s"
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


        if (mbpsEnd) {

            mbpsEnd.innerText =
                show(
                    avg_speed * 8,
                    [
                        "Bps",
                        "Kbps",
                        "Mbps",
                        "Gbps",
                        "Tbps",
                        "Pbps"
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


        var describe =
            document.getElementById(
                "describe"
            );


        if (describe) {

            describe.innerText =
                DOWNLOAD_MODE === "proxy"
                    ? "平均速度（代理流）"
                    : "平均速度";
        }
    }


    lsat_all_down = 0;
}


/*
 * ============================================================
 * 总流量
 * ============================================================
 */

async function total() {

    var all_down =
        sum(thread_down);


    var currentTotal =
        all_down_sum +
        all_down;


    if (visibl) {

        var totalEl =
            document.getElementById(
                "total"
            );


        if (totalEl) {

            totalEl.innerText =
                show(
                    currentTotal,
                    [
                        "B",
                        "KB",
                        "MB",
                        "GB",
                        "TB",
                        "PB"
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


    /*
     * Maximum 由 index.html 定义。
     */
    if (
        typeof Maximum !== "undefined" &&
        (
            currentTotal >= Maximum &&
            Maximum != 0
        )
    ) {

        stop();


        return;
    }


    if (run) {

        setTimeout(
            total,
            16
        );

        return;
    }


    /*
     * 停止时把这一轮累计进去。
     */
    all_down_sum +=
        all_down;


    if (visibl) {

        var totalEnd =
            document.getElementById(
                "total"
            );


        if (totalEnd) {

            totalEnd.innerText =
                show(
                    all_down_sum,
                    [
                        "B",
                        "KB",
                        "MB",
                        "GB",
                        "TB",
                        "PB"
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
 * ============================================================
 * 国内 IP
 * ============================================================
 */

var cnip = "";


function ipcn() {

    if (visibl) {

        fetch(
            "https://forge.speedtest.cn/api/location/info",
            {
                referrerPolicy:
                    "no-referrer"
            }
        )
        .then(
            function(response) {

                return response.json();
            }
        )
        .then(
            function(data) {

                var tag =
                    document.getElementById(
                        "ipcn"
                    );


                if (!tag) {
                    return;
                }


                tag.innerText =
                    data["ip"] +
                    " " +
                    data["province"] +
                    " " +
                    data["city"] +
                    " " +
                    data["distinct"] +
                    " " +
                    data["isp"];


                if (
                    data["ip"] !== cnip
                ) {

                    tag.style.color =
                        "";

                    ckip(
                        data["ip"],
                        tag
                    );
                }


                cnip =
                    data["ip"];
            }
        )
        .catch(
            function() {}
        );
    }


    setTimeout(
        ipcn,
        5000
    );
}


/*
 * ============================================================
 * 全球 IP
 * ============================================================
 */

var gbip = "";


function ipgb() {

    if (visibl) {

        fetch(
            "https://api-ipv4.ip.sb/geoip",
            {
                referrerPolicy:
                    "no-referrer"
            }
        )
        .then(
            function(response) {

                return response.json();
            }
        )
        .then(
            function(data) {

                var tag =
                    document.getElementById(
                        "ipgb"
                    );


                if (!tag) {
                    return;
                }


                var country =
                    CountryCode_Zh_cn[
                        data["country_code"]
                    ] ||
                    data["country_code"] ||
                    "";


                /*
                 * 如果浏览器支持 Intl.DisplayNames，
                 * 尝试显示完整中文国家名称。
                 */
                try {

                    if (
                        !CountryCode_Zh_cn[
                            data["country_code"]
                        ] &&
                        typeof Intl !==
                            "undefined" &&
                        Intl.DisplayNames
                    ) {

                        var dn =
                            new Intl.DisplayNames(
                                [
                                    "zh-CN"
                                ],
                                {
                                    type:
                                        "region"
                                }
                            );


                        country =
                            dn.of(
                                data[
                                    "country_code"
                                ]
                            );
                    }

                } catch (e) {}


                tag.innerText =
                    data["ip"] +
                    " " +
                    country +
                    " " +
                    data["isp"];


                if (
                    data["ip"] !== gbip
                ) {

                    tag.style.color =
                        "";

                    ckip(
                        data["ip"],
                        tag
                    );
                }


                gbip =
                    data["ip"];
            }
        )
        .catch(
            function() {}
        );
    }


    setTimeout(
        ipgb,
        refresh_lay
    );
}


/*
 * ============================================================
 * 国内延迟
 * ============================================================
 */

function laycn() {

    if (visibl) {

        var start_ti =
            new Date().getTime();


        fetch(
            "https://connectivitycheck.platform.hicloud.com/generate_204",
            {
                method:
                    "HEAD",

                cache:
                    "no-store",

                mode:
                    "no-cors",

                referrerPolicy:
                    "no-referrer"
            }
        )
        .then(
            function() {

                var lay =
                    new Date().getTime() -
                    start_ti;


                now_local_ping =
                    lay;


                var el =
                    document.getElementById(
                        "laycn"
                    );


                if (el) {

                    el.innerText =
                        lay +
                        "ms";
                }
            }
        )
        .catch(
            function() {

                var el =
                    document.getElementById(
                        "laycn"
                    );


                if (el) {

                    el.innerText =
                        "-ms";
                }
            }
        );
    }


    setTimeout(
        laycn,
        1000
    );
}


/*
 * ============================================================
 * 全球延迟
 * ============================================================
 */

function laygb() {

    if (visibl) {

        var start_ti =
            new Date().getTime();


        fetch(
            "https://cp.cloudflare.com/",
            {
                method:
                    "HEAD",

                cache:
                    "no-store",

                mode:
                    "no-cors",

                referrerPolicy:
                    "no-referrer"
            }
        )
        .then(
            function() {

                var lay =
                    new Date().getTime() -
                    start_ti;


                now_global_ping =
                    lay;


                var el =
                    document.getElementById(
                        "laygb"
                    );


                if (el) {

                    el.innerText =
                        lay +
                        "ms";
                }
            }
        )
        .catch(
            function() {

                var el =
                    document.getElementById(
                        "laygb"
                    );


                if (el) {

                    el.innerText =
                        "-ms";
                }
            }
        );
    }


    setTimeout(
        laygb,
        1000
    );
}


/*
 * ============================================================
 * 海外连通性
 * ============================================================
 */

function ckbl() {

    if (visibl) {

        var controller =
            new AbortController();


        setTimeout(
            function() {

                try {

                    controller.abort();

                } catch (e) {}
            },
            2000
        );


        fetch(
            "https://twitter.com/",
            {
                signal:
                    controller.signal,

                method:
                    "HEAD",

                cache:
                    "no-store",

                mode:
                    "no-cors",

                referrerPolicy:
                    "no-referrer"
            }
        )
        .then(
            function() {

                var el =
                    document.getElementById(
                        "laygb"
                    );


                if (el) {

                    el.style.color =
                        "green";
                }
            }
        )
        .catch(
            function() {

                var el =
                    document.getElementById(
                        "laygb"
                    );


                if (el) {

                    el.style.color =
                        "red";
                }
            }
        );
    }


    setTimeout(
        ckbl,
        1000
    );
}


/*
 * ============================================================
 * IP ISP 检测
 * ============================================================
 */

function ckip(
    ip,
    tag
) {

    if (!checkIP) {
        return;
    }


    fetch(
        "https://down.ljxnet.cn/?headers=%7B%22referer%22%3A%22https%3A%2F%2Fipinfo.io%2F%22%2C%22origin%22%3A%22https%3A%2F%2Fipinfo.io%2F%22%7D&url=https%3A%2F%2Fipinfo.io%2Fwidget%2Fdemo%2F" +
        ip
    )
    .then(
        function(response) {

            return response.json();
        }
    )
    .then(
        function(data) {

            try {

                console.log(
                    data.input,
                    data.data.country,
                    data.data.city,
                    data.data.asn.name,
                    data.data.company.type
                );


                if (
                    data.data.company.type ===
                    "isp"
                ) {

                    tag.style.color =
                        "green";
                }

            } catch (e) {}
        }
    )
    .catch(
        function() {}
    );
}


/*
 * ============================================================
 * 初始化
 * ============================================================
 */

ipcn();

ipgb();

laycn();

laygb();

ckbl();


/*
 * ============================================================
 * 页面前后台
 * ============================================================
 */

document.addEventListener(
    "visibilitychange",
    function() {

        var state =
            document.visibilityState;


        if (
            state === "hidden"
        ) {

            visibl = false;


            var switchEl =
                document.getElementById(
                    "customSwitch2"
                );


            if (
                run &&
                switchEl &&
                !switchEl.checked
            ) {

                botton_clicked();
            }
        }


        if (
            state === "visible"
        ) {

            visibl = true;

            document.title =
                "流量杀手";
        }
    }
);


/*
 * ============================================================
 * ECharts
 * ============================================================
 */

var chartDom =
    document.getElementById(
        "dv"
    );


var myChart =
    echarts.init(
        chartDom
    );


var option;


option = {

    tooltip: {

        trigger:
            "axis",

        axisPointer: {

            type:
                "cross",

            label: {

                backgroundColor:
                    "#6a7985"
            }
        }
    },


    legend: {

        data: [
            "Speed",
            "Local Ping",
            "Global Ping"
        ]
    },


    toolbox: {

        feature: {

            saveAsImage: {}
        }
    },


    grid: {

        left:
            "3%",

        right:
            "4%",

        bottom:
            "3%",

        containLabel:
            true
    },


    xAxis: [{

        type:
            "category",

        name:
            "时间(s)",

        boundaryGap:
            false
    }],


    yAxis: [{

        type:
            "value",

        name:
            "延迟(ms)",

        splitLine: {

            show:
                false
        }

    }, {

        type:
            "value",

        name:
            "速率(MB/s)",

        splitLine: {

            show:
                false
        }
    }],


    series: [{

        name:
            "速率",

        type:
            "line",

        stack:
            "Total",

        yAxisIndex:
            1,

        areaStyle: {},

        emphasis: {

            focus:
                "series"
        },

        data: [{

            name:
                new Date(),

            value:
                now_speed
        }]

    }, {

        name:
            "延迟",

        type:
            "line",

        data: [{

            name:
                new Date(),

            value:
                now_global_ping
        }]
    }]
};


if (myChart) {

    myChart.setOption(
        option
    );
}


/*
 * ============================================================
 * 图表刷新
 * ============================================================
 */

function dv() {

    if (
        visibl &&
        myChart
    ) {

        var now =
            new Date();


        option.series[0]
            .data
            .push({

                name:
                    now.toString(),

                value: [
                    now.getTime(),
                    Number(
                        now_speed.toFixed(
                            1
                        )
                    )
                ]
            });


        option.series[1]
            .data
            .push({

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


/*
 * ============================================================
 * 调试信息
 * ============================================================
 */

console.log(
    "[traffic-killer] loaded"
);

console.log(
    "[traffic-killer] proxy:",
    TRAFFIC_PROXY || "(未配置)"
);
