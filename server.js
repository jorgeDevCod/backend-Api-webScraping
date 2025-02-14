import { config } from 'dotenv';
config();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import puppeteer from 'puppeteer';
import chromium from 'chrome-aws-lambda';
import pQueue from 'p-queue';
import validator from 'validator';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath( import.meta.url );
const __dirname = path.dirname( __filename );
const isDev = process.env.NODE_ENV !== 'production';


const app = express();
const PORT = process.env.PORT || 3000;
let browser;

// Configuración de caché
import NodeCache from 'node-cache';
const metaCache = new NodeCache( { stdTTL: 3600 } ); // 1 hora de caché

// Middleware de sanitización de URLs
const sanitizeUrls = ( req, res, next ) => {
    if ( req.body.urls ) {
        req.body.urls = req.body.urls.map( url => {
            try {
                const sanitizedUrl = new URL( url );
                return sanitizedUrl.toString();
            } catch ( e ) {
                return null;
            }
        } ).filter( Boolean );
    }
    next();
};

// Middleware de seguridad
app.use( helmet( {
    contentSecurityPolicy: {
        directives: {
            defaultSrc: [ "'self'" ],
            scriptSrc: [ "'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com", "https://cdnjs.cloudflare.com" ],
            styleSrc: [ "'self'", "'unsafe-inline'", "https://fonts.googleapis.com" ],
            fontSrc: [ "'self'", "https://fonts.gstatic.com" ],
            imgSrc: [ "'self'", "data:", "https:" ],
            connectSrc: [ "'self'" ]
        }
    },
    crossOriginEmbedderPolicy: false
} ) );

app.use( cors( {
    origin: '*', // Temporalmente para pruebas
    methods: [ 'GET', 'POST' ],
    credentials: true
} ) );
app.use( express.json( { limit: '50mb' } ) );
app.use( express.static( 'public' ) );
app.use( '/api/', rateLimit( { windowMs: 15 * 60 * 1000, max: 100 } ) ); // Rate limiting

app.get( '*', ( req, res ) => {
    res.sendFile( path.join( __dirname, 'public', 'index.html' ) );
} );

app.get( "/", ( req, res ) => {
    res.json( { message: "API funcionando en Vercel" } );
} );

app.get( '/api/test', async ( req, res ) => {
    try {
        res.json( { status: 'API is working' } );
    } catch ( error ) {
        res.status( 500 ).json( { error: error.message } );
    }
} );

app.use( ( err, req, res, next ) => {
    console.error( err.stack );
    res.status( 500 ).json( { error: 'Internal server error', message: err.message } );
} );

app.use( cors() );
app.use( express.json( { limit: '50mb' } ) );

app.use( cors( {
    origin: [
        'http://localhost:3000',
        'https://extraer-mtdatos-online.netlify.app/'
    ],
    credentials: true
} ) );
// Servir archivos estáticos
app.use( express.static( 'public' ) );

// Rate limiting
const limiter = rateLimit( {
    windowMs: 15 * 60 * 1000,
    max: 100
} );
app.use( '/api/', limiter );

// Cola de procesamiento concurrente
const queue = new pQueue( { concurrency: 3 } );

// Inicialización del navegador
async function initBrowser() {
    const options = isDev
        ? {
            args: [ '--no-sandbox' ],
            headless: 'new'
        }
        : {
            args: chromium.args,
            executablePath: await chromium.executablePath,
            headless: chromium.headless
        };

    try {
        browser = await puppeteer.launch( options );
        console.log( 'Browser initialized successfully' );
    } catch ( error ) {
        console.error( 'Failed to initialize browser:', error );
        throw error;
    }
}


async function createPage() {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout( 30000 );

    // Optimizar uso de recursos
    await page.setRequestInterception( true );
    page.on( 'request', ( req ) => {
        if ( [ 'image', 'stylesheet', 'font', 'script', 'media' ].includes( req.resourceType() ) ) {
            req.abort();
        } else {
            req.continue();
        }
    } );

    // Configurar headers por defecto
    await page.setExtraHTTPHeaders( {
        'User-Agent': 'MetaTag Analyzer Bot/1.0',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    } );

    return page;
}

// Función para extraer meta tags
async function scrapeMetaTags( url ) {
    let page;
    try {
        page = await browser.newPage();
        await page.setDefaultNavigationTimeout( 30000 );

        // Resource optimization
        await page.setRequestInterception( true );
        page.on( 'request', ( req ) => {
            if ( [ 'image', 'stylesheet', 'font', 'script', 'media' ].includes( req.resourceType() ) ) {
                req.abort();
            } else {
                req.continue();
            }
        } );

        await page.setExtraHTTPHeaders( {
            'User-Agent': 'MetaTag Analyzer Bot/1.0',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        } );

        const response = await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 30000 } );
        if ( !response.ok() ) {
            throw new Error( `HTTP error! status: ${response.status()} for ${url}` );
        }

        const metaTags = await page.evaluate( () => {
            const tags = [];
            const selectors = {
                title: 'title',
                description: 'meta[name="description"]',
                canonical: 'link[rel="canonical"]',
                h1: 'h1',
                ogTags: 'meta[property^="og:"]'
            };

            const extractContent = ( element, type ) => {
                if ( !element ) return null;
                switch ( type ) {
                    case 'text': return element.textContent.trim();
                    case 'content': return element.getAttribute( 'content' );
                    case 'href': return element.getAttribute( 'href' );
                    default: return null;
                }
            };

            for ( const [ key, selector ] of Object.entries( selectors ) ) {
                if ( key === 'ogTags' ) {
                    document.querySelectorAll( selector ).forEach( tag => {
                        tags.push( {
                            name: tag.getAttribute( 'property' ),
                            content: extractContent( tag, 'content' )
                        } );
                    } );
                } else {
                    const element = document.querySelector( selector );
                    if ( element ) {
                        tags.push( {
                            name: key,
                            content: extractContent( element, key === 'canonical' ? 'href' : ( key === 'title' || key === 'h1' ? 'text' : 'content' ) )
                        } );
                    }
                }
            }
            return tags;
        } );

        return { url, status: 'success', metaTags };

    } catch ( error ) {
        return { url, status: 'error', error: error.message, metaTags: [] };
    } finally {
        if ( page ) await page.close();
    }
}

// Endpoint principal de scraping
app.post( '/api/scrape', ( req, res ) => {
    if ( !req.body.urls || !Array.isArray( req.body.urls ) ) {
        return res.status( 400 ).json( { error: "URLs are required and must be an array." } );
    }

    const urls = req.body.urls.map( url => {
        try {
            return new URL( url ).toString();
        } catch ( e ) {
            return null;
        }
    } ).filter( Boolean );

    const results = [];
    const urlsToScrape = [];

    for ( const url of urls ) {
        const cached = metaCache.get( url );
        if ( cached ) {
            results.push( cached );
        } else {
            urlsToScrape.push( url );
        }
    }

    if ( urlsToScrape.length > 0 ) {
        Promise.all( urlsToScrape.map( url => queue.add( () => scrapeMetaTags( url ) ) ) )
            .then( newResults => {
                newResults.forEach( result => {
                    if ( result.status === 'success' ) {
                        metaCache.set( result.url, result );
                    }
                } );
                results.push( ...newResults );
                res.json( results );
            } )
            .catch( error => {
                console.error( 'Error in server:', error );
                res.status( 500 ).json( { error: 'Internal server error', message: error.message } );
            } );
    } else {
        res.json( results );
    }

} );


// Ruta para servir el frontend
app.get( '*', ( req, res ) => {
    res.sendFile( path.join( __dirname, 'public', 'index.html' ) );
} );

// Manejo de errores global
app.use( ( err, req, res, next ) => {
    console.error( err.stack );
    res.status( 500 ).json( {
        error: 'Error interno del servidor',
        message: err.message
    } );
} );

// Manejo de cierre limpio
process.on( 'SIGTERM', async () => {
    console.log( 'Closing server...' );
    if ( browser ) {
        console.log( 'Closing browser...' );
        await browser.close();
    }
    process.exit( 0 );
} );

process.on( 'SIGINT', async () => {
    console.log( 'Closing server...' );
    if ( browser ) {
        console.log( 'Closing browser...' );
        await browser.close();
    }
    process.exit( 0 );
} );

// Inicialización del servidor
async function startServer() {
    try {
        await initBrowser();
        app.listen( PORT, () => {
            console.log( `SServidor corriendo en puerto: http://localhost:${PORT}` );
        } );
    } catch ( error ) {
        console.error( 'Error starting server:', error );
        process.exit( 1 );

    }
}

export default startServer();
