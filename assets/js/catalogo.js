/*
CATALOGO.JS
Render del catálogo con buscador, filtro de categorías, orden y stock seguro
*/
import {
    cargarInventario,
    getProductosCatalogo,
    obtenerStock,
    onStockChange
} from "./data.js";

import {
    agregarProductoCatalogo,
    inicializarCarrito
} from "./carrito.js";

let categoriaActiva = "";
let textoBusqueda = "";
let ordenActivo = "relevancia";

async function initCatalogo() {
    if (!document.getElementById("catalogo")) return;

    await cargarInventario();
    inicializarCarrito();

    const selCat = document.getElementById("filtro-categoria");
    const inpBusq = document.getElementById("filtro-busqueda");
    const selOrd = document.getElementById("filtro-orden");

    selCat?.addEventListener("change", () => {
        categoriaActiva = selCat.value || "";
        renderCatalogo();
    });

    inpBusq?.addEventListener("input", () => {
        textoBusqueda = (inpBusq.value || "").trim().toLowerCase();
        renderCatalogo();
    });

    selOrd?.addEventListener("change", () => {
        ordenActivo = selOrd.value || "relevancia";
        renderCatalogo();
    });

    renderCatalogo();
    onStockChange(() => renderCatalogo());
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCatalogo);
} else {
    initCatalogo();
}

/* ===============================
NOTIFICACIÓN TOAST NO INTRUSIVA
=============================== */
let toastTimer = null;
function mostrarToastCatalogo(texto, esError = false) {
    let toast = document.getElementById("su-catalog-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "su-catalog-toast";
        toast.setAttribute("role", "status");
        toast.setAttribute("aria-live", "polite");
        toast.style.cssText =
            "position:fixed; top:18px; right:18px; z-index:3500; padding:12px 18px; border-radius:10px;" +
            "background:rgba(17,17,34,0.96); backdrop-filter:blur(10px); color:var(--color-text);" +
            "box-shadow:0 8px 24px rgba(0,0,0,0.45); font-size:0.92rem; max-width:340px;" +
            "transition:opacity 0.25s ease, transform 0.25s ease; opacity:0; transform:translateY(-8px);";
        document.body.appendChild(toast);
    }
    toast.style.border = esError ? "1px solid #ff4c4c" : "1px solid var(--color-accent)";
    toast.textContent = texto;
    toast.style.display = "block";
    requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    });

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        setTimeout(() => {
            if (toast.style.opacity === "0") toast.style.display = "none";
        }, 260);
    }, 2600);
}

/* ===============================
UTILIDAD DE PRECIO
=============================== */
function formatearPrecio(valor) {
    return valor.toLocaleString("es-CO");
}

/* ===============================
RENDER DEL CATÁLOGO
=============================== */
function renderCatalogo() {
    const contenedor = document.getElementById("catalogo");
    const contadorEl = document.getElementById("catalogo-contador");
    if (!contenedor) return;

    contenedor.innerHTML = "";

    let productos = getProductosCatalogo().slice();

    if (categoriaActiva) {
        productos = productos.filter(p => (p.categoria || "").trim() === categoriaActiva);
    }

    if (textoBusqueda) {
        productos = productos.filter(p =>
            (p.nombre || "").toLowerCase().includes(textoBusqueda) ||
            (p.categoria || "").toLowerCase().includes(textoBusqueda)
        );
    }

    if (ordenActivo === "precio-asc") {
        productos.sort((a, b) => (a.precio_referencia || 0) - (b.precio_referencia || 0));
    } else if (ordenActivo === "precio-desc") {
        productos.sort((a, b) => (b.precio_referencia || 0) - (a.precio_referencia || 0));
    } else if (ordenActivo === "nombre-asc") {
        productos.sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    }

    if (contadorEl) {
        contadorEl.textContent = `${productos.length} producto${productos.length === 1 ? "" : "s"}`;
    }

    if (productos.length === 0) {
        contenedor.innerHTML = "<p>No hay productos disponibles con esos filtros.</p>";
        return;
    }

    productos.forEach(producto => {
        const stockActual = obtenerStock()[producto.id] ?? 0;

        const card = document.createElement("div");
        card.className = "card producto-card";

        const imgSrc = "/" + String(producto.imagen || "").replace(/^\.?\//, "");

        const precioHtml = producto.precio_original && producto.precio_original > producto.precio_referencia
            ? `<p><del style="color:var(--color-text-muted); margin-right:6px;">$${formatearPrecio(producto.precio_original)}</del><strong style="color:var(--color-accent);">$${formatearPrecio(producto.precio_referencia)}</strong></p>`
            : `<p><strong>$${formatearPrecio(producto.precio_referencia)}</strong></p>`;

        card.innerHTML = `
        <div class="producto-imagen">
            <img src="${imgSrc}" alt="${producto.nombre}">
        </div>

        <div class="producto-info">
            <h3>${producto.nombre}</h3>
            ${precioHtml}
            <small>Stock disponible: ${stockActual}</small>
        </div>

        <div class="producto-accion">
            <div class="cantidad-control">
            <button class="menos">−</button>
            <span class="cantidad">0</span>
            <button class="mas">+</button>
            </div>
            <button class="agregar" disabled>Agregar al carrito</button>
        </div>
        `;

        let cantidad = 0;

        const spanCantidad = card.querySelector(".cantidad");
        const btnMenos = card.querySelector(".menos");
        const btnMas = card.querySelector(".mas");
        const btnAgregar = card.querySelector(".agregar");
        const stockLabel = card.querySelector("small");

        const actualizarBoton = () => {
            btnAgregar.disabled = cantidad === 0 || stockActual === 0;
            btnMas.disabled = cantidad >= stockActual;
            btnMenos.disabled = cantidad === 0;
        };

        const actualizarStockVisual = () => {
            const restante = stockActual - cantidad;
            stockLabel.textContent = `Stock disponible: ${restante}`;
        };

        btnMenos.onclick = () => {
            if (cantidad > 0) {
                cantidad--;
                spanCantidad.textContent = cantidad;
                actualizarBoton();
                actualizarStockVisual();
            }
        };

        btnMas.onclick = () => {
            if (cantidad < stockActual) {
                cantidad++;
                spanCantidad.textContent = cantidad;
                actualizarBoton();
                actualizarStockVisual();
            }
        };

        btnAgregar.onclick = async () => {
            if (cantidad === 0) return;

            btnAgregar.disabled = true;
            btnAgregar.textContent = "Agregando...";

            try {
                for (let i = 0; i < cantidad; i++) {
                    await agregarProductoCatalogo(producto);
                }
                mostrarToastCatalogo(`Agregaste ${cantidad} unidad(es) de ${producto.nombre} al carrito.`);
            } catch (err) {
                mostrarToastCatalogo(err?.message || "No se pudo agregar al carrito.", true);
            }
            renderCatalogo();
        };

        contenedor.appendChild(card);
        actualizarStockVisual();
        actualizarBoton();
    });
}
