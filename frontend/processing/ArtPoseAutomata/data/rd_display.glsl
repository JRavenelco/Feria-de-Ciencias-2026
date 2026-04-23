/*
 * rd_display.glsl
 * Fragment shader: mapea canales R (A) y G (B) de la textura RD
 * a una paleta orgánica de cian-magenta sobre fondo profundo.
 * Compatible con GLSL ES 1.00 (VideoCore VII / RPi 5).
 */

#ifdef GL_ES
precision mediump float;
#endif

uniform sampler2D tex;
uniform vec2      resolution;
uniform float     time;

varying vec4 vertColor;
varying vec4 vertTexCoord;

// Paleta: mapea concentración de B (0‥1) a color
vec3 palette(float t) {
    // Control points (pueden modificarse para cambiar la estética)
    vec3 background  = vec3(0.02, 0.04, 0.12);   // azul muy oscuro
    vec3 mid         = vec3(0.00, 0.78, 0.65);   // cian orgánico
    vec3 peak        = vec3(0.90, 0.15, 0.75);   // magenta vivo

    vec3 col = background;
    col = mix(col, mid,  smoothstep(0.15, 0.45, t));
    col = mix(col, peak, smoothstep(0.45, 0.75, t));

    // Brillo extra en picos altos (efecto bioluminiscente)
    col += 0.18 * vec3(0.6, 1.0, 0.8) * smoothstep(0.70, 0.90, t);

    return col;
}

void main() {
    // vertTexCoord ya viene en rango [0,1] desde Processing P2D
    vec2 uv = vertTexCoord.xy;

    vec4 state = texture2D(tex, uv);
    float A = state.r;   // canal rojo = concentración A (escalado 0‥1)
    float B = state.g;   // canal verde = concentración B

    // La diferencia A-B enfatiza los bordes del patrón
    float pattern = B - (1.0 - A) * 0.4;
    pattern = clamp(pattern, 0.0, 1.0);

    // Pulso suave sincronizado al tiempo (efecto "respiración")
    float pulse = 0.03 * sin(time * 1.8);
    pattern = clamp(pattern + pulse * B, 0.0, 1.0);

    vec3 color = palette(pattern);

    gl_FragColor = vec4(color, 1.0);
}
